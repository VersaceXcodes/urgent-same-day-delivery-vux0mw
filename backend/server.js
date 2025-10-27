import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import geolib from 'geolib';

// Load environment variables
dotenv.config();

// Import PostgreSQL client
import pkg from 'pg';
const { Pool } = pkg;
const { DATABASE_URL, PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGPORT = 5432 } = process.env;

const pool = new Pool(
  DATABASE_URL
    ? { 
        connectionString: DATABASE_URL, 
        ssl: { require: true } 
      }
    : {
        host: PGHOST,
        database: PGDATABASE,
        user: PGUSER,
        password: PGPASSWORD,
        port: Number(PGPORT),
        ssl: { require: true },
      }
);

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  }
});

// Configure middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Configure storage for file uploads
const storage_dir = './storage';
if (!fs.existsSync(storage_dir)) {
  fs.mkdirSync(storage_dir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let uploadDir = path.join(storage_dir, file.fieldname);
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

// ESM workaround for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Middleware to serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, storage_dir)));

// JWT authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ success: false, error: 'Access denied', message: 'Authentication token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, error: 'Invalid token', message: 'Token is invalid or expired' });
    }

    req.user = user;
    next();
  });
};

// Courier role middleware
const courierOnly = (req, res, next) => {
  if (req.user.user_type !== 'courier') {
    return res.status(403).json({ success: false, error: 'Forbidden', message: 'This action requires a courier account' });
  }
  next();
};

// Sender role middleware
const senderOnly = (req, res, next) => {
  if (req.user.user_type !== 'sender') {
    return res.status(403).json({ success: false, error: 'Forbidden', message: 'This action requires a sender account' });
  }
  next();
};

// ----- Helper Functions -----

/**
 * Generate a JWT token for a user
 * @param {Object} user - User object
 * @returns {String} JWT token
 */
function generateToken(user) {
  return jwt.sign(
    { 
      uid: user.uid, 
      email: user.email, 
      user_type: user.user_type 
    }, 
    process.env.JWT_SECRET || 'your_jwt_secret', 
    { expiresIn: '24h' }
  );
}

/**
 * Parse error object and return appropriate message
 * @param {Error} error - Error object
 * @returns {string} Human-readable error message
 */
function parseError(error) {
  console.error(error);
  if (error.constraint) {
    if (error.constraint.includes('email')) {
      return 'Email already in use';
    } else if (error.constraint.includes('phone')) {
      return 'Phone number already in use';
    }
  }
  return error.message || 'An unexpected error occurred';
}

/**
 * Creates a tracking link token for a delivery
 * @param {string} delivery_id - Delivery ID
 * @param {boolean} is_recipient - Whether the link is for recipient
 * @returns {Promise<string>} Tracking token
 */
async function createTrackingLink(delivery_id, is_recipient = false) {
  const token = uuidv4();
  const expires_at = new Date();
  expires_at.setDate(expires_at.getDate() + 7); // Expire in 7 days
  
  const client = await pool.connect();
  try {
    await client.query(
      'INSERT INTO delivery_tracking_links (uid, delivery_id, token, expires_at, is_recipient_link) VALUES ($1, $2, $3, $4, $5)',
      [uuidv4(), delivery_id, token, expires_at, is_recipient]
    );
    return token;
  } finally {
    client.release();
  }
}

/**
 * Validates a delivery tracking token
 * @param {string} token - Tracking token
 * @returns {Promise<Object|null>} Delivery object or null if invalid
 */
async function validateTrackingToken(token) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT d.* FROM delivery_tracking_links l JOIN deliveries d ON l.delivery_id = d.uid WHERE l.token = $1 AND l.expires_at > NOW()',
      [token]
    );
    
    if (result.rows.length === 0) {
      return null;
    }
    
    // Update access count
    await client.query(
      'UPDATE delivery_tracking_links SET access_count = access_count + 1, last_accessed_at = NOW() WHERE token = $1',
      [token]
    );
    
    return result.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Calculates delivery cost based on various factors
 * 
 * @@need:external-api: Distance matrix API to calculate accurate distance and duration
 * 
 * @param {Object} params - Parameters for cost calculation
 * @returns {Object} Pricing breakdown
 */
async function calculateDeliveryCost({ 
  pickup_location, 
  delivery_location, 
  package_type_id, 
  package_weight = 0,
  priority_level = 'standard' 
}) {
  const client = await pool.connect();
  try {
    // Get package type information
    const packageResult = await client.query('SELECT * FROM package_types WHERE uid = $1', [package_type_id]);
    if (packageResult.rows.length === 0) {
      throw new Error('Invalid package type');
    }
    
    const packageType = packageResult.rows[0];
    
    // Get system settings
    const settingsResult = await client.query('SELECT * FROM system_settings WHERE key IN ($1, $2, $3, $4)', [
      'base_price_multiplier',
      'urgent_price_multiplier',
      'express_price_multiplier',
      'tax_rate'
    ]);
    
    const settings = {};
    settingsResult.rows.forEach(row => {
      settings[row.key] = parseFloat(row.value);
    });
    
    const basePriceMultiplier = settings.base_price_multiplier || 1;
    const urgentMultiplier = settings.urgent_price_multiplier || 1.5;
    const expressMultiplier = settings.express_price_multiplier || 1.25;
    const taxRate = settings.tax_rate || 0.0875;
    
    // Calculate distance - in a real app we would use a distance matrix API
    // Here we'll just use a simple formula for demonstration
    const distance = geolib.getDistance(
      { latitude: pickup_location.lat, longitude: pickup_location.lng },
      { latitude: delivery_location.lat, longitude: delivery_location.lng }
    ) / 1000; // Convert to kilometers
    
    // Convert to miles if needed
    const distanceMiles = distance * 0.621371;
    
    // Calculate duration (minutes) - very rough estimate
    const estimatedDuration = Math.round(distanceMiles * 5); // 5 minutes per mile
    
    // Base pricing
    const baseFee = packageType.base_price * basePriceMultiplier;
    const distanceFee = distanceMiles * 1.25; // $1.25 per mile
    
    // Weight fee
    let weightFee = 0;
    if (package_weight > packageType.max_weight * 0.5) {
      weightFee = (package_weight / packageType.max_weight) * 5; // Up to $5 based on weight ratio
    }
    
    // Priority fee
    let priorityFee = 0;
    if (priority_level === 'urgent') {
      priorityFee = baseFee * (urgentMultiplier - 1);
    } else if (priority_level === 'express') {
      priorityFee = baseFee * (expressMultiplier - 1);
    }
    
    // Calculate subtotal and tax
    const subtotal = baseFee + distanceFee + weightFee + priorityFee;
    const tax = subtotal * taxRate;
    
    // Total
    const total = subtotal + tax;
    
    return {
      base_fee: parseFloat(baseFee.toFixed(2)),
      distance_fee: parseFloat(distanceFee.toFixed(2)),
      weight_fee: parseFloat(weightFee.toFixed(2)),
      priority_fee: parseFloat(priorityFee.toFixed(2)),
      tax: parseFloat(tax.toFixed(2)),
      discount: 0,
      total: parseFloat(total.toFixed(2)),
      distance: parseFloat(distanceMiles.toFixed(2)),
      estimated_duration: estimatedDuration
    };
  } finally {
    client.release();
  }
}

/**
 * Validates a promo code and returns discount information
 * @param {Object} params - Parameters for promo validation
 * @returns {Object} Promo code details and discount amount
 */
async function validatePromoCode({ code, user_id, order_amount = 0 }) {
  const client = await pool.connect();
  try {
    // Get promo code details
    const promoResult = await client.query(`
      SELECT p.* FROM promo_codes p
      WHERE p.code = $1 AND p.is_active = true
        AND (p.end_date IS NULL OR p.end_date > NOW())
        AND (p.usage_limit IS NULL OR p.current_usage < p.usage_limit)
    `, [code]);
    
    if (promoResult.rows.length === 0) {
      return { valid: false, message: 'Invalid or expired promo code' };
    }
    
    const promo = promoResult.rows[0];
    
    // Check minimum order amount
    if (order_amount < promo.minimum_order_amount) {
      return { 
        valid: false, 
        message: `Order must be at least $${promo.minimum_order_amount} to use this code`
      };
    }
    
    // Check if one-time and already used
    if (promo.is_one_time) {
      const usageResult = await client.query(`
        SELECT * FROM user_promo_usage
        WHERE user_id = $1 AND promo_code_id = $2
      `, [user_id, promo.uid]);
      
      if (usageResult.rows.length > 0) {
        return { valid: false, message: 'You have already used this promo code' };
      }
    }
    
    // Check if first-time user restriction applies
    if (promo.is_first_time_user) {
      const deliveryResult = await client.query(`
        SELECT * FROM deliveries WHERE sender_id = $1 AND status = 'delivered' LIMIT 1
      `, [user_id]);
      
      if (deliveryResult.rows.length > 0) {
        return { valid: false, message: 'This promo code is for first-time users only' };
      }
    }
    
    // Calculate discount
    let calculatedDiscount = 0;
    if (promo.discount_type === 'percentage') {
      calculatedDiscount = (order_amount * promo.discount_value) / 100;
      if (promo.maximum_discount && calculatedDiscount > promo.maximum_discount) {
        calculatedDiscount = promo.maximum_discount;
      }
    } else { // fixed_amount
      calculatedDiscount = promo.discount_value;
      if (calculatedDiscount > order_amount) {
        calculatedDiscount = order_amount;
      }
    }
    
    return {
      valid: true,
      promo_code: {
        uid: promo.uid,
        code: promo.code,
        description: promo.description,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value,
        minimum_order_amount: promo.minimum_order_amount,
        calculated_discount: parseFloat(calculatedDiscount.toFixed(2))
      },
      message: 'Promo code applied successfully'
    };
  } finally {
    client.release();
  }
}

/**
 * Processes payment for a delivery
 * 
 * @@need:external-api: Payment processor API to tokenize and process payments
 * 
 * @param {Object} params - Payment details
 * @returns {Object} Payment processing result
 */
async function processPayment({ 
  delivery_id, 
  sender_id, 
  payment_method_id, 
  pricing, 
  promo_code_id = null 
}) {
  // In a real application, this would interact with a payment gateway API
  // For this demonstration, we'll simulate a successful payment
  
  const paymentUid = uuidv4();
  const status = 'authorized';
  const transaction_id = `txn_${Date.now()}`;
  
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO payments (
        uid, delivery_id, sender_id, amount, payment_method_id, status, transaction_id,
        base_fee, distance_fee, weight_fee, priority_fee, tax, promo_code_id, discount_amount
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    `, [
      paymentUid,
      delivery_id,
      sender_id,
      pricing.total,
      payment_method_id,
      status,
      transaction_id,
      pricing.base_fee,
      pricing.distance_fee,
      pricing.weight_fee,
      pricing.priority_fee,
      pricing.tax,
      promo_code_id,
      pricing.discount
    ]);
    
    // If promo code was used, record the usage
    if (promo_code_id) {
      await client.query(`
        INSERT INTO user_promo_usage (uid, user_id, promo_code_id, delivery_id, discount_amount)
        VALUES ($1, $2, $3, $4, $5)
      `, [uuidv4(), sender_id, promo_code_id, delivery_id, pricing.discount]);
      
      // Update promo code usage count
      await client.query(`
        UPDATE promo_codes SET current_usage = current_usage + 1 WHERE uid = $1
      `, [promo_code_id]);
    }
    
    return {
      uid: paymentUid,
      status,
      amount: pricing.total,
      breakdown: pricing
    };
  } finally {
    client.release();
  }
}

// Initialize Socket.IO connections and handlers
const socketUsers = new Map(); // Store user socket mappings
const userSockets = new Map(); // Store socket-to-user mappings

io.use((socket, next) => {
  const token = socket.handshake.auth.token || socket.handshake.query.token;
  
  if (!token) {
    return next(new Error('Authentication token required'));
  }
  
  jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', (err, user) => {
    if (err) {
      return next(new Error('Invalid token'));
    }
    
    socket.user = user;
    next();
  });
});

io.on('connection', (socket) => {
  // Store user connection
  if (socket.user) {
    // Add to maps
    if (!socketUsers.has(socket.user.uid)) {
      socketUsers.set(socket.user.uid, new Set());
    }
    socketUsers.get(socket.user.uid).add(socket.id);
    userSockets.set(socket.id, socket.user.uid);
    
    // Send authentication confirmation
    socket.emit('auth_response', {
      authenticated: true,
      user_id: socket.user.uid,
      channels: [`user:${socket.user.uid}`],
      message: 'Successfully authenticated'
    });
    
    // Automatically join personal channel
    socket.join(`user:${socket.user.uid}`);
    
    // Join active delivery channel for courier
    if (socket.user.user_type === 'courier') {
      findCourierActiveDelivery(socket.user.uid)
        .then(delivery => {
          if (delivery) {
            socket.join(`delivery:${delivery.uid}`);
          }
        })
        .catch(err => console.error('Error finding courier active delivery:', err));
    }
    
    console.log(`User ${socket.user.uid} connected with socket ${socket.id}`);
  }

  // Handle courier location updates
  socket.on('courier_location_update', async (data) => {
    if (socket.user?.user_type !== 'courier') {
      socket.emit('error', { message: 'Unauthorized: Courier role required' });
      return;
    }
    
    try {
      const result = await updateCourierLocation(socket.user.uid, data);
      
      // Broadcast location update to delivery channel if associated with a delivery
      if (data.delivery_id) {
        io.to(`delivery:${data.delivery_id}`).emit('track_delivery_location', {
          delivery_id: data.delivery_id,
          courier_location: {
            lat: data.location.lat,
            lng: data.location.lng,
            heading: data.location.heading,
            speed: data.location.speed,
            updated_at: new Date().toISOString()
          },
          status: result.delivery_status,
          estimated_arrival_time: result.estimated_arrival_time
        });
      }
      
      socket.emit('location_update_confirmation', result);
    } catch (error) {
      console.error('Error updating courier location:', error);
      socket.emit('error', { message: 'Failed to update location' });
    }
  });
  
  // Handle new messages
  socket.on('new_message', async (data) => {
    try {
      // Validate delivery access
      let hasAccess = false;
      
      if (data.tracking_token) {
        const delivery = await validateTrackingToken(data.tracking_token);
        hasAccess = !!delivery && delivery.uid === data.delivery_id;
      } else if (socket.user) {
        const delivery = await getDeliveryWithAccess(data.delivery_id, socket.user.uid);
        hasAccess = !!delivery;
      }
      
      if (!hasAccess) {
        socket.emit('error', { message: 'Unauthorized: No access to this delivery' });
        return;
      }
      
      // Create message
      const message = await createMessage(data, socket.user);
      
      // Broadcast to delivery channel
      io.to(`delivery:${data.delivery_id}`).emit('new_message', { message });
      
      // Send personal confirmation
      socket.emit('message_sent', { success: true, message_id: message.uid });
    } catch (error) {
      console.error('Error sending message:', error);
      socket.emit('error', { message: 'Failed to send message' });
    }
  });
  
  // Handle message read status
  socket.on('message_read', async (data) => {
    if (!socket.user) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    
    try {
      const result = await markMessageRead(data.message_id, socket.user.uid);
      if (result) {
        io.to(`delivery:${result.delivery_id}`).emit('message_read', {
          message_id: data.message_id,
          is_read: true,
          read_at: result.read_at,
          reader_id: socket.user.uid
        });
      }
    } catch (error) {
      console.error('Error marking message read:', error);
      socket.emit('error', { message: 'Failed to update message status' });
    }
  });
  
  // Handle typing indicators
  socket.on('typing_indicator', async (data) => {
    if (!socket.user) {
      socket.emit('error', { message: 'Unauthorized' });
      return;
    }
    
    try {
      // Check if user has access to this delivery
      const delivery = await getDeliveryWithAccess(data.delivery_id, socket.user.uid);
      if (!delivery) {
        socket.emit('error', { message: 'Unauthorized: No access to this delivery' });
        return;
      }
      
      // Get user's name for the notification
      const userResult = await pool.query('SELECT first_name, last_name FROM users WHERE uid = $1', [socket.user.uid]);
      const user = userResult.rows[0];
      
      // Determine user type in this delivery
      let user_type = 'recipient'; // default
      if (delivery.sender_id === socket.user.uid) {
        user_type = 'sender';
      } else if (delivery.courier_id === socket.user.uid) {
        user_type = 'courier';
      }
      
      io.to(`delivery:${data.delivery_id}`).emit('typing_indicator', {
        delivery_id: data.delivery_id,
        user_id: socket.user.uid,
        user_name: `${user.first_name} ${user.last_name}`,
        user_type: user_type,
        is_typing: data.is_typing
      });
    } catch (error) {
      console.error('Error with typing indicator:', error);
      socket.emit('error', { message: 'Failed to send typing indicator' });
    }
  });
  
  socket.on('disconnect', async () => {
    const userId = userSockets.get(socket.id);
    if (userId) {
      // Remove from maps
      userSockets.delete(socket.id);
      const userSocketSet = socketUsers.get(userId);
      if (userSocketSet) {
        userSocketSet.delete(socket.id);
        if (userSocketSet.size === 0) {
          socketUsers.delete(userId);
          
          // Handle courier disconnect - update availability if offline too long
          if (socket.user?.user_type === 'courier') {
            console.log(`Courier ${userId} disconnected completely`);
            // In a production app, you might want to handle this after a timeout
            // For now we'll leave courier status unchanged
          }
        }
      }
      console.log(`User ${userId} disconnected from socket ${socket.id}`);
    }
  });
});

/**
 * Find the active delivery for a courier
 * @param {string} courier_id - Courier user ID
 * @returns {Promise<Object|null>} Delivery object or null
 */
async function findCourierActiveDelivery(courier_id) {
  const client = await pool.connect();
  try {
    // Check if courier has an active delivery set in their profile
    const profileResult = await client.query(
      'SELECT active_delivery_id FROM courier_profiles WHERE user_id = $1',
      [courier_id]
    );
    
    if (!profileResult.rows[0]?.active_delivery_id) {
      return null;
    }
    
    const deliveryId = profileResult.rows[0].active_delivery_id;
    
    // Get the delivery details
    const deliveryResult = await client.query(
      'SELECT * FROM deliveries WHERE uid = $1 AND courier_id = $2',
      [deliveryId, courier_id]
    );
    
    if (deliveryResult.rows.length === 0) {
      return null;
    }
    
    return deliveryResult.rows[0];
  } finally {
    client.release();
  }
}

/**
 * Update courier location and handle related status updates
 * @param {string} courier_id - Courier user ID
 * @param {Object} data - Location data
 * @returns {Promise<Object>} Update result
 */
async function updateCourierLocation(courier_id, data) {
  const client = await pool.connect();
  try {
    // Update courier profile location
    await client.query(
      'UPDATE courier_profiles SET current_location_lat = $1, current_location_lng = $2, location_updated_at = NOW() WHERE user_id = $3',
      [data.location.lat, data.location.lng, courier_id]
    );
    
    // Create location update record
    const locationUpdateId = uuidv4();
    await client.query(
      `INSERT INTO location_updates 
       (uid, user_id, delivery_id, latitude, longitude, accuracy, heading, speed, battery_level, device_info) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        locationUpdateId, 
        courier_id, 
        data.delivery_id || null, 
        data.location.lat,
        data.location.lng, 
        data.location.accuracy || null,
        data.location.heading || null,
        data.location.speed || null,
        data.battery_level || null,
        data.device_info || null
      ]
    );
    
    // Handle delivery status updates based on location if there's an active delivery
    let statusUpdate = { triggered: false };
    let delivery_status = null;
    let estimated_arrival_time = null;
    
    if (data.delivery_id) {
      // Get current delivery information
      const deliveryResult = await client.query(
        `SELECT d.*, 
          pickup.lat as pickup_lat, pickup.lng as pickup_lng,
          dropoff.lat as dropoff_lat, dropoff.lng as dropoff_lng 
        FROM deliveries d
        JOIN addresses pickup ON d.pickup_address_id = pickup.uid
        JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
        WHERE d.uid = $1 AND d.courier_id = $2`,
        [data.delivery_id, courier_id]
      );
      
      if (deliveryResult.rows.length > 0) {
        const delivery = deliveryResult.rows[0];
        delivery_status = delivery.status;
        estimated_arrival_time = delivery.estimated_delivery_time;
        
        // Calculate distances
        const distanceToPickup = geolib.getDistance(
          { latitude: data.location.lat, longitude: data.location.lng },
          { latitude: delivery.pickup_lat, longitude: delivery.pickup_lng }
        );
        
        const distanceToDropoff = geolib.getDistance(
          { latitude: data.location.lat, longitude: data.location.lng },
          { latitude: delivery.dropoff_lat, longitude: delivery.dropoff_lng }
        );
        
        // Update status based on proximity and current status
        if (delivery.status === 'en_route_to_pickup' && distanceToPickup < 200) {
          // Within 200m of pickup location
          await updateDeliveryStatus(data.delivery_id, courier_id, 'approaching_pickup', data.location);
          delivery_status = 'approaching_pickup';
          statusUpdate = {
            triggered: true,
            new_status: 'approaching_pickup'
          };
        } else if (delivery.status === 'in_transit' && distanceToDropoff < 500) {
          // Within 500m of dropoff location
          await updateDeliveryStatus(data.delivery_id, courier_id, 'approaching_dropoff', data.location);
          delivery_status = 'approaching_dropoff';
          statusUpdate = {
            triggered: true,
            new_status: 'approaching_dropoff'
          };
        }
        
        // Update ETA based on new location
        // In a real app, we would use a routing API to get accurate ETA
        // Here we'll use a simple approximation
        if (delivery.status === 'en_route_to_pickup' || delivery.status === 'approaching_pickup') {
          const speedMetersPerSecond = data.location.speed || 8; // Default to ~18mph if no speed data
          const etaSeconds = distanceToPickup / speedMetersPerSecond;
          const eta = new Date(Date.now() + etaSeconds * 1000);
          estimated_arrival_time = eta.toISOString();
        } else if (delivery.status === 'in_transit' || delivery.status === 'approaching_dropoff') {
          const speedMetersPerSecond = data.location.speed || 8; // Default to ~18mph if no speed data
          const etaSeconds = distanceToDropoff / speedMetersPerSecond;
          const eta = new Date(Date.now() + etaSeconds * 1000);
          estimated_arrival_time = eta.toISOString();
          
          // Update estimated delivery time in database
          await client.query(
            'UPDATE deliveries SET estimated_delivery_time = $1 WHERE uid = $2',
            [eta, data.delivery_id]
          );
          
          statusUpdate.estimated_time_update = estimated_arrival_time;
        }
      }
    }
    
    return {
      uid: locationUpdateId,
      latitude: data.location.lat,
      longitude: data.location.lng,
      timestamp: new Date().toISOString(),
      status_update: statusUpdate,
      delivery_status: delivery_status,
      estimated_arrival_time: estimated_arrival_time
    };
  } finally {
    client.release();
  }
}

/**
 * Update delivery status and create status update record
 * @param {string} delivery_id - Delivery ID
 * @param {string} courier_id - Courier user ID
 * @param {string} status - New status
 * @param {Object} location - Location data
 * @returns {Promise<Object>} Status update result
 */
async function updateDeliveryStatus(delivery_id, courier_id, status, location = null, notes = null) {
  const client = await pool.connect();
  try {
    // Update delivery status
    await client.query(
      'UPDATE deliveries SET status = $1, current_status_since = NOW() WHERE uid = $2',
      [status, delivery_id]
    );
    
    // Create status update record
    const updateId = uuidv4();
    await client.query(
      `INSERT INTO delivery_status_updates 
       (uid, delivery_id, status, latitude, longitude, notes, updated_by) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        updateId,
        delivery_id,
        status,
        location?.lat || null,
        location?.lng || null,
        notes || null,
        courier_id
      ]
    );
    
    // Get delivery details for notification
    const deliveryResult = await client.query(
      'SELECT sender_id, pickup_address_id, delivery_address_id FROM deliveries WHERE uid = $1',
      [delivery_id]
    );
    
    if (deliveryResult.rows.length > 0) {
      const delivery = deliveryResult.rows[0];
      
      // Create notification for sender
      await createNotification({
        user_id: delivery.sender_id,
        delivery_id,
        type: 'status_update',
        title: `Delivery Status Update: ${status.replace(/_/g, ' ')}`,
        content: `Your delivery has been updated to status: ${status.replace(/_/g, ' ')}`,
        action_url: `/deliveries/${delivery_id}`
      });
      
      // Broadcast to relevant sockets
      const senderSocketIds = socketUsers.get(delivery.sender_id);
      if (senderSocketIds) {
        // Get previous status
        const prevStatusResult = await client.query(
          `SELECT status FROM delivery_status_updates 
           WHERE delivery_id = $1 AND uid != $2 
           ORDER BY timestamp DESC LIMIT 1`,
          [delivery_id, updateId]
        );
        
        const previous_status = prevStatusResult.rows.length > 0 
          ? prevStatusResult.rows[0].status 
          : 'pending';
        
        io.to(`user:${delivery.sender_id}`).emit('delivery_status_change', {
          delivery_id,
          previous_status,
          new_status: status,
          timestamp: new Date().toISOString(),
          updated_by: 'courier',
          location: location ? {
            lat: location.lat,
            lng: location.lng
          } : null,
          notes
        });
      }
    }
    
    return {
      update_id: updateId,
      status,
      timestamp: new Date().toISOString()
    };
  } finally {
    client.release();
  }
}

/**
 * Create a notification record and broadcast it to the user
 * @param {Object} notification - Notification data
 * @returns {Promise<Object>} Created notification
 */
async function createNotification({ user_id, delivery_id = null, type, title, content, action_url = null, image_url = null }) {
  const client = await pool.connect();
  try {
    const notification_id = uuidv4();
    
    // Create notification record
    await client.query(
      `INSERT INTO notifications
       (uid, user_id, delivery_id, type, title, content, action_url, image_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [notification_id, user_id, delivery_id, type, title, content, action_url, image_url]
    );
    
    const notification = {
      uid: notification_id,
      type,
      title,
      content,
      action_url,
      image_url,
      delivery_id,
      created_at: new Date().toISOString()
    };
    
    // Broadcast to user's sockets if connected
    io.to(`user:${user_id}`).emit('notification', { notification });
    
    return notification;
  } finally {
    client.release();
  }
}

/**
 * Check if a user has access to a delivery
 * @param {string} delivery_id - Delivery ID
 * @param {string} user_id - User ID
 * @returns {Promise<Object|null>} Delivery object if access allowed, null otherwise
 */
async function getDeliveryWithAccess(delivery_id, user_id) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM deliveries WHERE uid = $1 AND (sender_id = $2 OR courier_id = $2)',
      [delivery_id, user_id]
    );
    
    return result.rows.length > 0 ? result.rows[0] : null;
  } finally {
    client.release();
  }
}

/**
 * Create a new message for a delivery
 * @param {Object} data - Message data
 * @param {Object} user - User object (optional, for recipient via tracking link)
 * @returns {Promise<Object>} Created message
 */
async function createMessage(data, user = null) {
  const client = await pool.connect();
  try {
    const message_id = uuidv4();
    let sender_id, sender_name, sender_type, recipient_id;
    
    // If message is from a tracked recipient (no user account)
    if (!user && data.tracking_token) {
      // Get delivery info
      const delivery = await validateTrackingToken(data.tracking_token);
      if (!delivery) {
        throw new Error('Invalid tracking token');
      }
      
      sender_id = 'recipient';
      sender_name = delivery.recipient_name || 'Recipient';
      sender_type = 'recipient';
      recipient_id = delivery.courier_id || delivery.sender_id; // Send to available party
    } else {
      // Regular authenticated user
      sender_id = user.uid;
      
      // Get user's name
      const userResult = await client.query(
        'SELECT first_name, last_name FROM users WHERE uid = $1',
        [user.uid]
      );
      
      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }
      
      sender_name = `${userResult.rows[0].first_name} ${userResult.rows[0].last_name}`;
      
      // Get delivery info to determine recipient
      const deliveryResult = await client.query(
        'SELECT sender_id, courier_id FROM deliveries WHERE uid = $1',
        [data.delivery_id]
      );
      
      if (deliveryResult.rows.length === 0) {
        throw new Error('Delivery not found');
      }
      
      const delivery = deliveryResult.rows[0];
      
      // Determine sender type and recipient
      if (user.uid === delivery.sender_id) {
        sender_type = 'sender';
        recipient_id = delivery.courier_id;
      } else if (user.uid === delivery.courier_id) {
        sender_type = 'courier';
        recipient_id = delivery.sender_id;
      } else {
        throw new Error('User is not associated with this delivery');
      }
    }
    
    // Create message record
    await client.query(
      `INSERT INTO messages
       (uid, delivery_id, sender_id, recipient_id, content, attachment_url, attachment_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        message_id,
        data.delivery_id,
        sender_id,
        recipient_id,
        data.content,
        data.attachment_url || null,
        data.attachment_type || null
      ]
    );
    
    // Create notification for recipient if they're not the 'recipient' placeholder
    if (recipient_id !== 'recipient') {
      await createNotification({
        user_id: recipient_id,
        delivery_id: data.delivery_id,
        type: 'message',
        title: 'New Message',
        content: `New message from ${sender_name}: ${data.content.substring(0, 50)}${data.content.length > 50 ? '...' : ''}`,
        action_url: `/deliveries/${data.delivery_id}/chat`
      });
    }
    
    return {
      uid: message_id,
      delivery_id: data.delivery_id,
      sender_id,
      sender_name,
      sender_type,
      recipient_id,
      content: data.content,
      attachment_url: data.attachment_url,
      attachment_type: data.attachment_type,
      is_read: false,
      created_at: new Date().toISOString()
    };
  } finally {
    client.release();
  }
}

/**
 * Mark a message as read
 * @param {string} message_id - Message ID
 * @param {string} user_id - User ID
 * @returns {Promise<Object|null>} Updated message or null if not authorized
 */
async function markMessageRead(message_id, user_id) {
  const client = await pool.connect();
  try {
    // Check if user is the recipient
    const messageResult = await client.query(
      'SELECT m.*, d.uid as delivery_id FROM messages m JOIN deliveries d ON m.delivery_id = d.uid WHERE m.uid = $1',
      [message_id]
    );
    
    if (messageResult.rows.length === 0) {
      return null;
    }
    
    const message = messageResult.rows[0];
    
    // Verify user is the recipient
    if (message.recipient_id !== user_id) {
      return null;
    }
    
    // Update message to read
    await client.query(
      'UPDATE messages SET is_read = true, read_at = NOW() WHERE uid = $1',
      [message_id]
    );
    
    return {
      message_id,
      delivery_id: message.delivery_id,
      read_at: new Date().toISOString()
    };
  } finally {
    client.release();
  }
}

//----- API Routes -----

// Authentication routes
app.post('/api/auth/register', async (req, res) => {
  const { email, password, phone_number, first_name, last_name, user_type, profile_picture_url } = req.body;
  
  // Basic validation
  if (!email || !password || !phone_number || !first_name || !last_name || !user_type) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'All required fields must be provided' });
  }
  
  if (!['sender', 'courier'].includes(user_type)) {
    return res.status(400).json({ success: false, error: 'Invalid user type', message: 'User type must be either sender or courier' });
  }
  
  const client = await pool.connect();
  try {
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);
    
    // Generate user ID
    const uid = uuidv4();
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Create user
    const result = await client.query(
      `INSERT INTO users (
        uid, email, password_hash, phone_number, first_name, last_name, profile_picture_url,
        user_type, status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW()) RETURNING *`,
      [uid, email, password_hash, phone_number, first_name, last_name, profile_picture_url, user_type, 'active']
    );
    
    const user = result.rows[0];
    
    // Create user preferences with default values
    await client.query(
      `INSERT INTO user_preferences (
        uid, user_id, push_new_message, push_status_updates, push_delivery_request,
        email_delivery_completion, email_receipts, email_promotions, sms_critical_updates,
        language, timezone, distance_unit
      ) VALUES ($1, $2, true, true, true, true, true, false, true, 'en', 'UTC', 'miles')`,
      [uuidv4(), uid]
    );
    
    // If user is a courier, create courier profile
    if (user_type === 'courier') {
      const courierProfileUid = uuidv4();
      await client.query(
        `INSERT INTO courier_profiles (
          uid, user_id, is_available, max_weight_capacity, background_check_status,
          id_verification_status, service_area_radius
        ) VALUES ($1, $2, false, 50, 'not_started', 'not_submitted', 20)`,
        [courierProfileUid, uid]
      );
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Generate JWT token
    const token = generateToken(user);
    
    // Send email verification (mock in this implementation)
    console.log(`[MOCK] Sending email verification to: ${email}`);
    
    // Send SMS verification (mock in this implementation) 
    console.log(`[MOCK] Sending SMS verification to: ${phone_number}`);
    
    res.status(201).json({
      success: true,
      user: {
        uid: user.uid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        user_type: user.user_type,
        phone_number: user.phone_number,
        profile_picture_url: user.profile_picture_url,
        status: user.status,
        created_at: user.created_at
      },
      token,
      message: 'User registered successfully. Please verify your email and phone.'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    const errorMessage = parseError(error);
    res.status(400).json({ success: false, error: errorMessage, message: 'Registration failed' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'Missing credentials', message: 'Email and password are required' });
  }
  
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, error: 'Invalid credentials', message: 'Email or password is incorrect' });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials', message: 'Email or password is incorrect' });
    }
    
    // Update last login timestamp
    await client.query('UPDATE users SET last_login_at = NOW() WHERE uid = $1', [user.uid]);
    
    // Generate token
    const token = generateToken(user);
    
    res.json({
      success: true,
      user: {
        uid: user.uid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        user_type: user.user_type,
        status: user.status,
        profile_picture_url: user.profile_picture_url,
        average_rating: user.average_rating,
        total_ratings: user.total_ratings
      },
      token,
      message: 'Login successful'
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/courier/complete-profile', authenticateToken, courierOnly, async (req, res) => {
  const { max_weight_capacity, service_area_radius, service_area_center_lat, service_area_center_lng, vehicle } = req.body;
  
  if (!max_weight_capacity || !service_area_radius || !vehicle || !vehicle.type) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'All required fields must be provided' });
  }
  
  const client = await pool.connect();
  try {
    // Begin transaction
    await client.query('BEGIN');
    
    // Get courier profile
    const profileResult = await client.query(
      'SELECT uid FROM courier_profiles WHERE user_id = $1',
      [req.user.uid]
    );
    
    if (profileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Not found', message: 'Courier profile not found' });
    }
    
    const courierProfileUid = profileResult.rows[0].uid;
    
    // Update courier profile
    await client.query(
      `UPDATE courier_profiles SET 
       max_weight_capacity = $1, service_area_radius = $2, 
       service_area_center_lat = $3, service_area_center_lng = $4, 
       updated_at = NOW() WHERE uid = $5`,
      [
        max_weight_capacity,
        service_area_radius,
        service_area_center_lat || null,
        service_area_center_lng || null,
        courierProfileUid
      ]
    );
    
    // Create vehicle
    const vehicleUid = uuidv4();
    await client.query(
      `INSERT INTO vehicles (
        uid, courier_id, type, make, model, year, color, 
        license_plate, max_capacity_volume, photo_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        vehicleUid,
        courierProfileUid,
        vehicle.type,
        vehicle.make || null,
        vehicle.model || null,
        vehicle.year || null,
        vehicle.color || null,
        vehicle.license_plate || null,
        vehicle.max_capacity_volume || null,
        vehicle.photo_url || null
      ]
    );
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.json({
      success: true,
      courier_profile: {
        uid: courierProfileUid,
        max_weight_capacity,
        service_area_radius,
        service_area_center_lat: service_area_center_lat || null,
        service_area_center_lng: service_area_center_lng || null,
        id_verification_status: 'not_submitted',
        background_check_status: 'not_started'
      },
      vehicle: {
        uid: vehicleUid,
        type: vehicle.type,
        make: vehicle.make || null,
        model: vehicle.model || null,
        year: vehicle.year || null,
        color: vehicle.color || null,
        license_plate: vehicle.license_plate || null,
        max_capacity_volume: vehicle.max_capacity_volume || null,
        photo_url: vehicle.photo_url || null,
        insurance_verified: false
      },
      message: 'Courier profile completed successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error completing courier profile:', error);
    res.status(400).json({ success: false, error: parseError(error), message: 'Failed to complete courier profile' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/password/reset-request', async (req, res) => {
  const { email } = req.body;
  
  if (!email) {
    return res.status(400).json({ success: false, error: 'Missing email', message: 'Email is required' });
  }
  
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'No account found with this email' });
    }
    
    // Generate reset token - in a real app, you'd store this in a table
    const resetToken = uuidv4();
    console.log(`[MOCK] Password reset token for ${email}: ${resetToken}`);
    console.log(`[MOCK] Sending password reset email to: ${email}`);
    
    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset link has been sent'
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/password/reset', async (req, res) => {
  const { token, new_password } = req.body;
  
  if (!token || !new_password) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Token and new password are required' });
  }
  
  // In a real app, you'd verify the token against your database
  // For this mock implementation, we'll just pretend the token is valid
  console.log(`[MOCK] Verifying password reset token: ${token}`);
  
  // Validate token
  if (token.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid token', message: 'The reset token is invalid or expired' });
  }
  
  // In a real app, you'd update the user's password in the database
  console.log(`[MOCK] Resetting password with token: ${token}`);
  
  res.json({
    success: true,
    message: 'Password has been reset successfully. You can now log in with your new password.'
  });
});

app.get('/api/auth/verify-email/:token', async (req, res) => {
  const { token } = req.params;
  
  // In a real app, you'd verify the token against your database
  // For this mock implementation, we'll just pretend the token is valid
  console.log(`[MOCK] Verifying email with token: ${token}`);
  
  // Validate token
  if (token.length < 10) {
    return res.status(400).json({ success: false, error: 'Invalid token', message: 'The verification token is invalid or expired' });
  }
  
  // In a real app, you'd update the user's email_verified status
  console.log(`[MOCK] Marking email as verified for token: ${token}`);
  
  res.json({
    success: true,
    message: 'Email verified successfully'
  });
});

app.post('/api/auth/verify-phone', authenticateToken, async (req, res) => {
  const { code } = req.body;
  
  if (!code) {
    return res.status(400).json({ success: false, error: 'Missing code', message: 'Verification code is required' });
  }
  
  // In a real app, you'd verify the code against what was sent to the user
  // For this mock implementation, we'll just check if it's 6 digits
  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({ success: false, error: 'Invalid code', message: 'The verification code is invalid' });
  }
  
  const client = await pool.connect();
  try {
    // Update user's phone_verified status
    await client.query('UPDATE users SET phone_verified = true WHERE uid = $1', [req.user.uid]);
    
    res.json({
      success: true,
      message: 'Phone number verified successfully'
    });
  } catch (error) {
    console.error('Phone verification error:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// User profile routes
app.get('/api/users/profile', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    // Get user data
    const userResult = await client.query('SELECT * FROM users WHERE uid = $1', [req.user.uid]);
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Get user preferences
    const preferencesResult = await client.query('SELECT * FROM user_preferences WHERE user_id = $1', [req.user.uid]);
    const preferences = preferencesResult.rows.length > 0 ? preferencesResult.rows[0] : {};
    
    // Build response object
    const response = {
      user: {
        uid: user.uid,
        email: user.email,
        first_name: user.first_name,
        last_name: user.last_name,
        phone_number: user.phone_number,
        profile_picture_url: user.profile_picture_url,
        user_type: user.user_type,
        status: user.status,
        average_rating: user.average_rating,
        total_ratings: user.total_ratings,
        account_balance: user.user_type === 'courier' ? parseFloat(user.account_balance) : undefined,
        email_verified: user.email_verified,
        phone_verified: user.phone_verified,
        created_at: user.created_at
      },
      preferences: {
        push_new_message: preferences.push_new_message,
        push_status_updates: preferences.push_status_updates,
        push_delivery_request: preferences.push_delivery_request,
        email_delivery_completion: preferences.email_delivery_completion,
        email_receipts: preferences.email_receipts,
        email_promotions: preferences.email_promotions,
        sms_critical_updates: preferences.sms_critical_updates,
        language: preferences.language,
        timezone: preferences.timezone,
        distance_unit: preferences.distance_unit
      }
    };
    
    // If user is a courier, get courier profile and vehicle
    if (user.user_type === 'courier') {
      const courierResult = await client.query('SELECT * FROM courier_profiles WHERE user_id = $1', [req.user.uid]);
      
      if (courierResult.rows.length > 0) {
        const courier = courierResult.rows[0];
        response.courier_profile = {
          is_available: courier.is_available,
          max_weight_capacity: parseFloat(courier.max_weight_capacity),
          background_check_status: courier.background_check_status,
          id_verification_status: courier.id_verification_status,
          service_area_radius: parseFloat(courier.service_area_radius),
          service_area_center_lat: courier.service_area_center_lat,
          service_area_center_lng: courier.service_area_center_lng,
          total_deliveries: courier.total_deliveries,
          completed_deliveries: courier.completed_deliveries,
          cancelled_deliveries: courier.cancelled_deliveries
        };
        
        // Get vehicle information
        const vehicleResult = await client.query('SELECT * FROM vehicles WHERE courier_id = $1', [courier.uid]);
        
        if (vehicleResult.rows.length > 0) {
          const vehicle = vehicleResult.rows[0];
          response.vehicle = {
            uid: vehicle.uid,
            type: vehicle.type,
            make: vehicle.make,
            model: vehicle.model,
            year: vehicle.year,
            color: vehicle.color,
            license_plate: vehicle.license_plate,
            insurance_verified: vehicle.insurance_verified,
            max_capacity_volume: parseFloat(vehicle.max_capacity_volume),
            photo_url: vehicle.photo_url
          };
        }
      }
    }
    
    res.json(response);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  const { first_name, last_name, profile_picture_url } = req.body;
  
  // Prepare update fields
  const updates = [];
  const values = [];
  let paramCount = 1;
  
  if (first_name !== undefined) {
    updates.push(`first_name = $${paramCount++}`);
    values.push(first_name);
  }
  
  if (last_name !== undefined) {
    updates.push(`last_name = $${paramCount++}`);
    values.push(last_name);
  }
  
  if (profile_picture_url !== undefined) {
    updates.push(`profile_picture_url = $${paramCount++}`);
    values.push(profile_picture_url);
  }
  
  if (updates.length === 0) {
    return res.status(400).json({ success: false, error: 'No updates', message: 'No fields to update were provided' });
  }
  
  updates.push(`updated_at = NOW()`);
  values.push(req.user.uid);
  
  const client = await pool.connect();
  try {
    // Update user
    const result = await client.query(
      `UPDATE users SET ${updates.join(', ')} WHERE uid = $${paramCount} RETURNING uid, first_name, last_name, profile_picture_url, updated_at`,
      values
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'User not found' });
    }
    
    res.json({
      success: true,
      user: result.rows[0],
      message: 'Profile updated successfully'
    });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/users/courier-profile', authenticateToken, courierOnly, async (req, res) => {
  const { courier_profile, vehicle } = req.body;
  
  if (!courier_profile && !vehicle) {
    return res.status(400).json({ success: false, error: 'No updates', message: 'No fields to update were provided' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Get courier profile
    const profileResult = await client.query(
      'SELECT uid FROM courier_profiles WHERE user_id = $1',
      [req.user.uid]
    );
    
    if (profileResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Not found', message: 'Courier profile not found' });
    }
    
    const courierProfileUid = profileResult.rows[0].uid;
    let updatedProfile, updatedVehicle;
    
    // Update courier profile if provided
    if (courier_profile) {
      const profileUpdates = [];
      const profileValues = [];
      let profileParamCount = 1;
      
      if (courier_profile.max_weight_capacity !== undefined) {
        profileUpdates.push(`max_weight_capacity = $${profileParamCount++}`);
        profileValues.push(courier_profile.max_weight_capacity);
      }
      
      if (courier_profile.service_area_radius !== undefined) {
        profileUpdates.push(`service_area_radius = $${profileParamCount++}`);
        profileValues.push(courier_profile.service_area_radius);
      }
      
      if (courier_profile.service_area_center_lat !== undefined) {
        profileUpdates.push(`service_area_center_lat = $${profileParamCount++}`);
        profileValues.push(courier_profile.service_area_center_lat);
      }
      
      if (courier_profile.service_area_center_lng !== undefined) {
        profileUpdates.push(`service_area_center_lng = $${profileParamCount++}`);
        profileValues.push(courier_profile.service_area_center_lng);
      }
      
      if (profileUpdates.length > 0) {
        profileUpdates.push(`updated_at = NOW()`);
        profileValues.push(courierProfileUid);
        
        const profileResult = await client.query(
          `UPDATE courier_profiles SET ${profileUpdates.join(', ')} WHERE uid = $${profileParamCount} RETURNING *`,
          profileValues
        );
        
        updatedProfile = profileResult.rows[0];
      }
    }
    
    // Update vehicle if provided
    if (vehicle) {
      // Get vehicle
      const vehicleResult = await client.query(
        'SELECT uid FROM vehicles WHERE courier_id = $1',
        [courierProfileUid]
      );
      
      if (vehicleResult.rows.length === 0) {
        // Create new vehicle if doesn't exist
        const vehicleUid = uuidv4();
        const vehicleValues = [
          vehicleUid,
          courierProfileUid,
          vehicle.type || 'car',
          vehicle.make || null,
          vehicle.model || null,
          vehicle.year || null,
          vehicle.color || null,
          vehicle.license_plate || null,
          vehicle.max_capacity_volume || null,
          vehicle.photo_url || null
        ];
        
        const newVehicleResult = await client.query(
          `INSERT INTO vehicles (
            uid, courier_id, type, make, model, year, color, 
            license_plate, max_capacity_volume, photo_url
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          vehicleValues
        );
        
        updatedVehicle = newVehicleResult.rows[0];
      } else {
        const vehicleUid = vehicleResult.rows[0].uid;
        const vehicleUpdates = [];
        const vehicleValues = [];
        let vehicleParamCount = 1;
        
        if (vehicle.type !== undefined) {
          vehicleUpdates.push(`type = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.type);
        }
        
        if (vehicle.make !== undefined) {
          vehicleUpdates.push(`make = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.make);
        }
        
        if (vehicle.model !== undefined) {
          vehicleUpdates.push(`model = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.model);
        }
        
        if (vehicle.year !== undefined) {
          vehicleUpdates.push(`year = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.year);
        }
        
        if (vehicle.color !== undefined) {
          vehicleUpdates.push(`color = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.color);
        }
        
        if (vehicle.license_plate !== undefined) {
          vehicleUpdates.push(`license_plate = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.license_plate);
        }
        
        if (vehicle.max_capacity_volume !== undefined) {
          vehicleUpdates.push(`max_capacity_volume = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.max_capacity_volume);
        }
        
        if (vehicle.photo_url !== undefined) {
          vehicleUpdates.push(`photo_url = $${vehicleParamCount++}`);
          vehicleValues.push(vehicle.photo_url);
        }
        
        if (vehicleUpdates.length > 0) {
          vehicleUpdates.push(`updated_at = NOW()`);
          vehicleValues.push(vehicleUid);
          
          const vehicleResult = await client.query(
            `UPDATE vehicles SET ${vehicleUpdates.join(', ')} WHERE uid = $${vehicleParamCount} RETURNING *`,
            vehicleValues
          );
          
          updatedVehicle = vehicleResult.rows[0];
        }
      }
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Prepare response
    const response = {
      success: true,
      message: 'Courier profile updated successfully'
    };
    
    if (updatedProfile) {
      response.courier_profile = {
        uid: updatedProfile.uid,
        max_weight_capacity: parseFloat(updatedProfile.max_weight_capacity),
        service_area_radius: parseFloat(updatedProfile.service_area_radius),
        service_area_center_lat: updatedProfile.service_area_center_lat,
        service_area_center_lng: updatedProfile.service_area_center_lng,
        updated_at: updatedProfile.updated_at
      };
    }
    
    if (updatedVehicle) {
      response.vehicle = {
        uid: updatedVehicle.uid,
        type: updatedVehicle.type,
        make: updatedVehicle.make,
        model: updatedVehicle.model,
        year: updatedVehicle.year,
        color: updatedVehicle.color,
        license_plate: updatedVehicle.license_plate,
        max_capacity_volume: parseFloat(updatedVehicle.max_capacity_volume),
        photo_url: updatedVehicle.photo_url,
        updated_at: updatedVehicle.updated_at
      };
    }
    
    res.json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating courier profile:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/users/preferences', authenticateToken, async (req, res) => {
  // Get fields that can be updated
  const updatableFields = [
    'push_new_message', 
    'push_status_updates', 
    'push_delivery_request',
    'email_delivery_completion', 
    'email_receipts', 
    'email_promotions', 
    'sms_critical_updates',
    'language', 
    'timezone', 
    'distance_unit'
  ];
  
  // Build update query
  const updates = [];
  const values = [];
  let paramCount = 1;
  
  updatableFields.forEach(field => {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = $${paramCount++}`);
      values.push(req.body[field]);
    }
  });
  
  if (updates.length === 0) {
    return res.status(400).json({ success: false, error: 'No updates', message: 'No fields to update were provided' });
  }
  
  updates.push(`updated_at = NOW()`);
  values.push(req.user.uid);
  
  const client = await pool.connect();
  try {
    // Update preferences
    const result = await client.query(
      `UPDATE user_preferences SET ${updates.join(', ')} WHERE user_id = $${paramCount} RETURNING *`,
      values
    );
    
    if (result.rows.length === 0) {
      // Create preferences if they don't exist
      const prefUid = uuidv4();
      
      // Build default values
      const defaultPrefs = {
        push_new_message: true,
        push_status_updates: true,
        push_delivery_request: true,
        email_delivery_completion: true,
        email_receipts: true,
        email_promotions: false,
        sms_critical_updates: true,
        language: 'en',
        timezone: 'UTC',
        distance_unit: 'miles'
      };
      
      // Override with any provided values
      updatableFields.forEach(field => {
        if (req.body[field] !== undefined) {
          defaultPrefs[field] = req.body[field];
        }
      });
      
      const createResult = await client.query(
        `INSERT INTO user_preferences (
          uid, user_id, push_new_message, push_status_updates, push_delivery_request,
          email_delivery_completion, email_receipts, email_promotions, sms_critical_updates,
          language, timezone, distance_unit
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [
          prefUid,
          req.user.uid,
          defaultPrefs.push_new_message,
          defaultPrefs.push_status_updates,
          defaultPrefs.push_delivery_request,
          defaultPrefs.email_delivery_completion,
          defaultPrefs.email_receipts,
          defaultPrefs.email_promotions,
          defaultPrefs.sms_critical_updates,
          defaultPrefs.language,
          defaultPrefs.timezone,
          defaultPrefs.distance_unit
        ]
      );
      
      res.json({
        success: true,
        preferences: createResult.rows[0],
        message: 'Preferences created successfully'
      });
    } else {
      res.json({
        success: true,
        preferences: result.rows[0],
        message: 'Preferences updated successfully'
      });
    }
  } catch (error) {
    console.error('Error updating preferences:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Payment methods routes
app.get('/api/users/payment-methods', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT pm.*, 
        addr.street_address, addr.unit_number, addr.city, addr.state, 
        addr.postal_code, addr.country
      FROM payment_methods pm
      LEFT JOIN addresses addr ON pm.billing_address_id = addr.uid
      WHERE pm.user_id = $1
      ORDER BY pm.is_default DESC, pm.created_at DESC
    `, [req.user.uid]);
    
    // Format response
    const payment_methods = result.rows.map(row => {
      const method = {
        uid: row.uid,
        payment_type: row.payment_type,
        provider: row.provider,
        last_four: row.last_four,
        expiry_month: row.expiry_month,
        expiry_year: row.expiry_year,
        is_default: row.is_default,
        created_at: row.created_at
      };
      
      // Add billing address if it exists
      if (row.street_address) {
        method.billing_address = {
          street_address: row.street_address,
          unit_number: row.unit_number,
          city: row.city,
          state: row.state,
          postal_code: row.postal_code,
          country: row.country
        };
      }
      
      return method;
    });
    
    res.json({ payment_methods });
  } catch (error) {
    console.error('Error fetching payment methods:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/users/payment-methods', authenticateToken, async (req, res) => {
  const { payment_type, token, provider, last_four, expiry_month, expiry_year, is_default, billing_address } = req.body;
  
  if (!payment_type || !token) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Payment type and token are required' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    let billing_address_id = null;
    
    // Create billing address if provided
    if (billing_address) {
      const addressUid = uuidv4();
      const addressResult = await client.query(
        `INSERT INTO addresses (
          uid, user_id, street_address, unit_number, city, state, 
          postal_code, country, lat, lng, is_saved
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [
          addressUid,
          req.user.uid,
          billing_address.street_address,
          billing_address.unit_number || null,
          billing_address.city,
          billing_address.state,
          billing_address.postal_code,
          billing_address.country || 'US',
          0, // Placeholder lat/lng - in a real app, you'd geocode
          0,
          false // Billing addresses are not saved in the addresses list
        ]
      );
      
      billing_address_id = addressResult.rows[0].uid;
    }
    
    // If setting as default, unset other defaults
    if (is_default) {
      await client.query(
        'UPDATE payment_methods SET is_default = false WHERE user_id = $1',
        [req.user.uid]
      );
    }
    
    // Create payment method
    const paymentMethodUid = uuidv4();
    const result = await client.query(
      `INSERT INTO payment_methods (
        uid, user_id, payment_type, provider, last_four, expiry_month,
        expiry_year, billing_address_id, is_default, token
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        paymentMethodUid,
        req.user.uid,
        payment_type,
        provider || null,
        last_four || null,
        expiry_month || null,
        expiry_year || null,
        billing_address_id,
        is_default || false,
        token
      ]
    );
    
    await client.query('COMMIT');
    
    let response = {
      success: true,
      message: 'Payment method added successfully',
      payment_method: {
        uid: result.rows[0].uid,
        payment_type: result.rows[0].payment_type,
        provider: result.rows[0].provider,
        last_four: result.rows[0].last_four,
        expiry_month: result.rows[0].expiry_month,
        expiry_year: result.rows[0].expiry_year,
        is_default: result.rows[0].is_default,
        created_at: result.rows[0].created_at
      }
    };
    
    // Add billing address to response if created
    if (billing_address_id) {
      response.payment_method.billing_address = {
        uid: billing_address_id,
        ...billing_address
      };
    }
    
    res.status(201).json(response);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding payment method:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.delete('/api/users/payment-methods/:id', authenticateToken, async (req, res) => {
  const paymentMethodId = req.params.id;
  
  const client = await pool.connect();
  try {
    // Check if payment method exists and belongs to user
    const checkResult = await client.query(
      'SELECT * FROM payment_methods WHERE uid = $1 AND user_id = $2',
      [paymentMethodId, req.user.uid]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Payment method not found' });
    }
    
    // Delete payment method
    await client.query('DELETE FROM payment_methods WHERE uid = $1', [paymentMethodId]);
    
    // If deleted method was default, set another as default
    if (checkResult.rows[0].is_default) {
      const nextDefaultResult = await client.query(
        'SELECT uid FROM payment_methods WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [req.user.uid]
      );
      
      if (nextDefaultResult.rows.length > 0) {
        await client.query(
          'UPDATE payment_methods SET is_default = true WHERE uid = $1',
          [nextDefaultResult.rows[0].uid]
        );
      }
    }
    
    res.json({
      success: true,
      message: 'Payment method deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting payment method:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/users/payment-methods/:id/default', authenticateToken, async (req, res) => {
  const paymentMethodId = req.params.id;
  
  const client = await pool.connect();
  try {
    // Check if payment method exists and belongs to user
    const checkResult = await client.query(
      'SELECT * FROM payment_methods WHERE uid = $1 AND user_id = $2',
      [paymentMethodId, req.user.uid]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Payment method not found' });
    }
    
    await client.query('BEGIN');
    
    // Unset all other default payment methods
    await client.query(
      'UPDATE payment_methods SET is_default = false WHERE user_id = $1',
      [req.user.uid]
    );
    
    // Set this payment method as default
    await client.query(
      'UPDATE payment_methods SET is_default = true WHERE uid = $1',
      [paymentMethodId]
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Default payment method updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating default payment method:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Courier earnings and bank account routes
app.get('/api/courier/earnings', authenticateToken, courierOnly, async (req, res) => {
  const { period = 'week', start_date, end_date } = req.query;
  
  // Define date range based on period
  let startTime, endTime;
  const now = new Date();
  endTime = now;
  
  if (start_date && end_date) {
    startTime = new Date(start_date);
    endTime = new Date(end_date);
  } else {
    switch(period) {
      case 'day':
        startTime = new Date(now);
        startTime.setHours(0, 0, 0, 0);
        break;
      case 'week':
        startTime = new Date(now);
        startTime.setDate(now.getDate() - now.getDay()); // Start of the week (Sunday)
        startTime.setHours(0, 0, 0, 0);
        break;
      case 'month':
        startTime = new Date(now.getFullYear(), now.getMonth(), 1); // Start of the month
        break;
      case 'all':
      default:
        startTime = new Date(0); // Beginning of time
        break;
    }
  }
  
  const client = await pool.connect();
  try {
    // Get courier's current balance
    const balanceResult = await client.query(
      'SELECT account_balance FROM users WHERE uid = $1',
      [req.user.uid]
    );
    
    const current_balance = parseFloat(balanceResult.rows[0]?.account_balance || 0);
    
    // Get earnings summary for the period
    const earningsSummaryResult = await client.query(`
      SELECT 
        SUM(p.amount) as total_earnings, 
        COUNT(DISTINCT d.uid) as completed_deliveries,
        SUM(p.tip_amount) as total_tips
      FROM deliveries d
      JOIN payments p ON d.uid = p.delivery_id
      WHERE d.courier_id = $1 
        AND d.status = 'delivered' 
        AND d.actual_delivery_time BETWEEN $2 AND $3
    `, [req.user.uid, startTime, endTime]);
    
    const summary = earningsSummaryResult.rows[0];
    
    // Get daily breakdown
    const earningsByDayResult = await client.query(`
      SELECT 
        DATE(d.actual_delivery_time) as date,
        SUM(p.amount) as amount,
        SUM(p.tip_amount) as tips,
        COUNT(DISTINCT d.uid) as deliveries
      FROM deliveries d
      JOIN payments p ON d.uid = p.delivery_id
      WHERE d.courier_id = $1 
        AND d.status = 'delivered' 
        AND d.actual_delivery_time BETWEEN $2 AND $3
      GROUP BY DATE(d.actual_delivery_time)
      ORDER BY date DESC
    `, [req.user.uid, startTime, endTime]);
    
    // Get recent payouts
    const payoutsResult = await client.query(`
      SELECT 
        uid, amount, status, period_start, period_end, delivery_count, created_at
      FROM courier_payouts
      WHERE courier_id = $1
      ORDER BY created_at DESC
      LIMIT 5
    `, [req.user.uid]);
    
    res.json({
      current_balance,
      earnings_summary: {
        total_earnings: parseFloat(summary.total_earnings || 0),
        completed_deliveries: parseInt(summary.completed_deliveries || 0),
        total_tips: parseFloat(summary.total_tips || 0),
        period
      },
      earnings_by_day: earningsByDayResult.rows.map(row => ({
        date: row.date,
        amount: parseFloat(row.amount || 0),
        tips: parseFloat(row.tips || 0),
        deliveries: parseInt(row.deliveries || 0)
      })),
      recent_payouts: payoutsResult.rows.map(row => ({
        uid: row.uid,
        amount: parseFloat(row.amount),
        status: row.status,
        period_start: row.period_start,
        period_end: row.period_end,
        delivery_count: row.delivery_count,
        created_at: row.created_at
      }))
    });
  } catch (error) {
    console.error('Error fetching courier earnings:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/courier/bank-accounts', authenticateToken, courierOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM bank_accounts WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC',
      [req.user.uid]
    );
    
    const bank_accounts = result.rows.map(row => ({
      uid: row.uid,
      account_holder_name: row.account_holder_name,
      account_type: row.account_type,
      bank_name: row.bank_name,
      masked_account_number: row.masked_account_number,
      is_verified: row.is_verified,
      is_default: row.is_default,
      created_at: row.created_at
    }));
    
    res.json({ bank_accounts });
  } catch (error) {
    console.error('Error fetching bank accounts:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/courier/bank-accounts', authenticateToken, courierOnly, async (req, res) => {
  const { account_holder_name, account_type, bank_name, account_number, routing_number, is_default } = req.body;
  
  if (!account_holder_name || !account_type || !bank_name || !account_number || !routing_number) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'All required fields must be provided' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // For security, mask the account number before storing
    const masked_account_number = 'XXXX' + account_number.slice(-4);
    
    // In a real app, you'd use a payment processor API to tokenize and verify the account
    const token = `bank_token_${Date.now()}`;
    
    // If setting as default, unset other defaults
    if (is_default) {
      await client.query(
        'UPDATE bank_accounts SET is_default = false WHERE user_id = $1',
        [req.user.uid]
      );
    }
    
    // Create bank account
    const bankAccountUid = uuidv4();
    const result = await client.query(
      `INSERT INTO bank_accounts (
        uid, user_id, account_holder_name, account_type, bank_name,
        masked_account_number, routing_number, token, is_verified, is_default
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        bankAccountUid,
        req.user.uid,
        account_holder_name,
        account_type,
        bank_name,
        masked_account_number,
        routing_number,
        token,
        false, // Newly added accounts start as unverified
        is_default || false
      ]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      bank_account: {
        uid: result.rows[0].uid,
        account_holder_name: result.rows[0].account_holder_name,
        account_type: result.rows[0].account_type,
        bank_name: result.rows[0].bank_name,
        masked_account_number: result.rows[0].masked_account_number,
        is_verified: result.rows[0].is_verified,
        is_default: result.rows[0].is_default,
        created_at: result.rows[0].created_at
      },
      message: 'Bank account added successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding bank account:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Address routes
app.get('/api/addresses', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM addresses WHERE user_id = $1 AND is_saved = true ORDER BY is_default DESC, created_at DESC',
      [req.user.uid]
    );
    
    const addresses = result.rows.map(row => ({
      uid: row.uid,
      label: row.label,
      street_address: row.street_address,
      unit_number: row.unit_number,
      city: row.city,
      state: row.state,
      postal_code: row.postal_code,
      country: row.country,
      lat: parseFloat(row.lat),
      lng: parseFloat(row.lng),
      is_default: row.is_default,
      delivery_instructions: row.delivery_instructions,
      access_code: row.access_code,
      landmark: row.landmark,
      created_at: row.created_at
    }));
    
    res.json({ addresses });
  } catch (error) {
    console.error('Error fetching addresses:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/addresses', authenticateToken, async (req, res) => {
  const { 
    label, street_address, unit_number, city, state, postal_code, country = 'US', 
    lat, lng, is_default, delivery_instructions, access_code, landmark 
  } = req.body;
  
  if (!street_address || !city || !state || !postal_code) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Street address, city, state, and postal code are required' });
  }
  
  let coordinates = { lat, lng };
  
  // If lat/lng not provided, we would normally use a geocoding API
  if (!lat || !lng) {
    // @@need:external-api: Geocoding API to convert address to coordinates
    // For now, we'll use mock coordinates
    coordinates = {
      lat: 37.7749 + (Math.random() - 0.5) * 0.1, // Approximate San Francisco area with some randomness
      lng: -122.4194 + (Math.random() - 0.5) * 0.1
    };
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // If setting as default, unset other defaults
    if (is_default) {
      await client.query(
        'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_saved = true',
        [req.user.uid]
      );
    }
    
    // Create address
    const addressUid = uuidv4();
    const result = await client.query(
      `INSERT INTO addresses (
        uid, user_id, label, street_address, unit_number, city, state,
        postal_code, country, lat, lng, is_default, delivery_instructions,
        access_code, landmark, is_saved
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true) RETURNING *`,
      [
        addressUid,
        req.user.uid,
        label || null,
        street_address,
        unit_number || null,
        city,
        state,
        postal_code,
        country,
        coordinates.lat,
        coordinates.lng,
        is_default || false,
        delivery_instructions || null,
        access_code || null,
        landmark || null
      ]
    );
    
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      address: {
        uid: result.rows[0].uid,
        label: result.rows[0].label,
        street_address: result.rows[0].street_address,
        unit_number: result.rows[0].unit_number,
        city: result.rows[0].city,
        state: result.rows[0].state,
        postal_code: result.rows[0].postal_code,
        country: result.rows[0].country,
        lat: parseFloat(result.rows[0].lat),
        lng: parseFloat(result.rows[0].lng),
        is_default: result.rows[0].is_default,
        delivery_instructions: result.rows[0].delivery_instructions,
        access_code: result.rows[0].access_code,
        landmark: result.rows[0].landmark,
        created_at: result.rows[0].created_at
      },
      message: 'Address added successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error adding address:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/addresses/:id', authenticateToken, async (req, res) => {
  const addressId = req.params.id;
  const { 
    label, street_address, unit_number, city, state, postal_code, country,
    lat, lng, is_default, delivery_instructions, access_code, landmark 
  } = req.body;
  
  const client = await pool.connect();
  try {
    // Check if address exists and belongs to user
    const checkResult = await client.query(
      'SELECT * FROM addresses WHERE uid = $1 AND user_id = $2',
      [addressId, req.user.uid]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Address not found' });
    }
    
    // Build update query
    const updates = [];
    const values = [];
    let paramCount = 1;
    
    if (label !== undefined) {
      updates.push(`label = $${paramCount++}`);
      values.push(label);
    }
    
    if (street_address !== undefined) {
      updates.push(`street_address = $${paramCount++}`);
      values.push(street_address);
    }
    
    if (unit_number !== undefined) {
      updates.push(`unit_number = $${paramCount++}`);
      values.push(unit_number);
    }
    
    if (city !== undefined) {
      updates.push(`city = $${paramCount++}`);
      values.push(city);
    }
    
    if (state !== undefined) {
      updates.push(`state = $${paramCount++}`);
      values.push(state);
    }
    
    if (postal_code !== undefined) {
      updates.push(`postal_code = $${paramCount++}`);
      values.push(postal_code);
    }
    
    if (country !== undefined) {
      updates.push(`country = $${paramCount++}`);
      values.push(country);
    }
    
    if (lat !== undefined) {
      updates.push(`lat = $${paramCount++}`);
      values.push(lat);
    }
    
    if (lng !== undefined) {
      updates.push(`lng = $${paramCount++}`);
      values.push(lng);
    }
    
    if (delivery_instructions !== undefined) {
      updates.push(`delivery_instructions = $${paramCount++}`);
      values.push(delivery_instructions);
    }
    
    if (access_code !== undefined) {
      updates.push(`access_code = $${paramCount++}`);
      values.push(access_code);
    }
    
    if (landmark !== undefined) {
      updates.push(`landmark = $${paramCount++}`);
      values.push(landmark);
    }
    
    if (updates.length === 0 && is_default === undefined) {
      return res.status(400).json({ success: false, error: 'No updates', message: 'No fields to update were provided' });
    }
    
    await client.query('BEGIN');
    
    // Handle default setting
    if (is_default) {
      // Unset all other defaults
      await client.query(
        'UPDATE addresses SET is_default = false WHERE user_id = $1 AND is_saved = true',
        [req.user.uid]
      );
      
      updates.push(`is_default = true`);
    } else if (is_default === false) {
      updates.push(`is_default = false`);
    }
    
    updates.push(`updated_at = NOW()`);
    values.push(addressId);
    
    // Update address
    const result = await client.query(
      `UPDATE addresses SET ${updates.join(', ')} WHERE uid = $${paramCount} RETURNING *`,
      values
    );
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      address: {
        uid: result.rows[0].uid,
        label: result.rows[0].label,
        street_address: result.rows[0].street_address,
        unit_number: result.rows[0].unit_number,
        city: result.rows[0].city,
        state: result.rows[0].state,
        postal_code: result.rows[0].postal_code,
        country: result.rows[0].country,
        lat: parseFloat(result.rows[0].lat),
        lng: parseFloat(result.rows[0].lng),
        is_default: result.rows[0].is_default,
        delivery_instructions: result.rows[0].delivery_instructions,
        access_code: result.rows[0].access_code,
        landmark: result.rows[0].landmark,
        updated_at: result.rows[0].updated_at
      },
      message: 'Address updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating address:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.delete('/api/addresses/:id', authenticateToken, async (req, res) => {
  const addressId = req.params.id;
  
  const client = await pool.connect();
  try {
    // Check if address exists and belongs to user
    const checkResult = await client.query(
      'SELECT * FROM addresses WHERE uid = $1 AND user_id = $2',
      [addressId, req.user.uid]
    );
    
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Address not found' });
    }
    
    // Check if address is used in any active deliveries
    const deliveryResult = await client.query(`
      SELECT * FROM deliveries 
      WHERE (pickup_address_id = $1 OR delivery_address_id = $1)
        AND status NOT IN ('delivered', 'cancelled', 'failed', 'returned')
    `, [addressId]);
    
    if (deliveryResult.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'In use', message: 'Address is used in active deliveries and cannot be deleted' });
    }
    
    await client.query('BEGIN');
    
    // Delete address
    await client.query('DELETE FROM addresses WHERE uid = $1', [addressId]);
    
    // If deleted address was default, set another as default
    if (checkResult.rows[0].is_default) {
      const nextDefaultResult = await client.query(
        'SELECT uid FROM addresses WHERE user_id = $1 AND is_saved = true ORDER BY created_at DESC LIMIT 1',
        [req.user.uid]
      );
      
      if (nextDefaultResult.rows.length > 0) {
        await client.query(
          'UPDATE addresses SET is_default = true WHERE uid = $1',
          [nextDefaultResult.rows[0].uid]
        );
      }
    }
    
    await client.query('COMMIT');
    
    res.json({
      success: true,
      message: 'Address deleted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting address:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/addresses/validate', authenticateToken, async (req, res) => {
  const { street_address, unit_number, city, state, postal_code, country = 'US' } = req.body;
  
  if (!street_address || !city || !state || !postal_code) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Street address, city, state, and postal code are required' });
  }
  
  try {
    // @@need:external-api: Address validation and geocoding API
    
    // For this demo, we'll always validate as true and return mock data
    const formattedAddress = `${street_address}${unit_number ? ` ${unit_number}` : ''}, ${city}, ${state} ${postal_code}, ${country}`;
    
    // Mock coordinates - in a real app, these would come from the geocoding API
    const coordinates = {
      lat: 37.7749 + (Math.random() - 0.5) * 0.1,
      lng: -122.4194 + (Math.random() - 0.5) * 0.1
    };
    
    res.json({
      valid: true,
      formatted_address: formattedAddress,
      components: {
        street_address,
        unit_number,
        city,
        state,
        postal_code,
        country
      },
      coordinates
    });
  } catch (error) {
    console.error('Error validating address:', error);
    res.status(400).json({
      valid: false,
      message: 'Address validation failed'
    });
  }
});

// Delivery management routes
app.get('/api/package-types', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT * FROM package_types WHERE is_active = true ORDER BY base_price'
    );
    
    const package_types = result.rows.map(row => ({
      uid: row.uid,
      name: row.name,
      description: row.description,
      max_weight: parseFloat(row.max_weight),
      dimensions: {
        length: parseFloat(row.dimension_x),
        width: parseFloat(row.dimension_y),
        height: parseFloat(row.dimension_z)
      },
      base_price: parseFloat(row.base_price),
      icon_url: row.icon_url
    }));
    
    res.json({ package_types });
  } catch (error) {
    console.error('Error fetching package types:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/deliveries/estimate', authenticateToken, async (req, res) => {
  const { 
    pickup_address, 
    delivery_address, 
    package_type_id, 
    package_weight, 
    priority_level = 'standard',
    promo_code 
  } = req.body;
  
  if (!pickup_address || !delivery_address || !package_type_id) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Pickup address, delivery address, and package type are required' });
  }
  
  try {
    // Calculate base pricing
    const pricing = await calculateDeliveryCost({
      pickup_location: pickup_address.lat && pickup_address.lng 
        ? pickup_address 
        : { lat: 37.7749, lng: -122.4194 }, // Default to SF coordinates if not provided
      delivery_location: delivery_address.lat && delivery_address.lng
        ? delivery_address
        : { lat: 37.7833, lng: -122.4167 }, // Default to SF coordinates if not provided
      package_type_id,
      package_weight,
      priority_level
    });
    
    // Calculate delivery time
    const now = new Date();
    const estimatedDeliveryTime = new Date(now.getTime() + (pricing.estimated_duration * 60000));
    
    // Check if service is available in the area
    const isServiceAvailable = true; // For this demo, we'll always say yes
    
    // Mock number of available couriers nearby
    const availableCouriersNearby = Math.floor(Math.random() * 10) + 1;
    
    // Check promo code if provided
    let promoApplied = null;
    if (promo_code) {
      const promoResult = await validatePromoCode({ 
        code: promo_code, 
        user_id: req.user.uid,
        order_amount: pricing.total
      });
      
      if (promoResult.valid) {
        promoApplied = {
          code: promoResult.promo_code.code,
          discount_type: promoResult.promo_code.discount_type,
          discount_value: promoResult.promo_code.discount_value,
          discount_amount: promoResult.promo_code.calculated_discount
        };
        
        // Apply discount to pricing
        pricing.discount = promoApplied.discount_amount;
        pricing.total = parseFloat((pricing.total - promoApplied.discount_amount).toFixed(2));
        if (pricing.total < 0) pricing.total = 0;
      }
    }
    
    res.json({
      estimate: {
        distance: pricing.distance,
        estimated_duration: pricing.estimated_duration,
        estimated_delivery_time: estimatedDeliveryTime.toISOString(),
        pricing: {
          base_fee: pricing.base_fee,
          distance_fee: pricing.distance_fee,
          weight_fee: pricing.weight_fee,
          priority_fee: pricing.priority_fee,
          tax: pricing.tax,
          discount: pricing.discount,
          total: pricing.total
        },
        is_service_available: isServiceAvailable,
        available_couriers_nearby: availableCouriersNearby
      },
      promo_applied: promoApplied
    });
  } catch (error) {
    console.error('Error estimating delivery:', error);
    res.status(400).json({ success: false, error: parseError(error), message: 'Could not estimate delivery' });
  }
});

app.post('/api/deliveries', authenticateToken, senderOnly, async (req, res) => {
  const { 
    pickup_address, delivery_address, package, recipient, 
    delivery_options = {}, payment 
  } = req.body;
  
  if (!pickup_address || !delivery_address || !package || !recipient || !payment) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'All required sections must be provided' });
  }
  
  if (!package.package_type_id || !package.description) {
    return res.status(400).json({ success: false, error: 'Invalid package', message: 'Package type and description are required' });
  }
  
  if (!recipient.name) {
    return res.status(400).json({ success: false, error: 'Invalid recipient', message: 'Recipient name is required' });
  }
  
  if (!payment.payment_method_id) {
    return res.status(400).json({ success: false, error: 'Invalid payment', message: 'Payment method is required' });
  }
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Process pickup address
    let pickup_address_id;
    if (pickup_address.use_saved_address_id) {
      // Verify this address belongs to the user
      const pickupAddressCheck = await client.query(
        'SELECT uid FROM addresses WHERE uid = $1 AND user_id = $2',
        [pickup_address.use_saved_address_id, req.user.uid]
      );
      
      if (pickupAddressCheck.rows.length === 0) {
        throw new Error('Invalid pickup address');
      }
      
      pickup_address_id = pickup_address.use_saved_address_id;
    } else {
      // Create a new address
      pickup_address_id = uuidv4();
      
      // If lat/lng not provided, we would normally use a geocoding API
      const pickupCoordinates = pickup_address.lat && pickup_address.lng 
        ? { lat: pickup_address.lat, lng: pickup_address.lng } 
        : { lat: 37.7749 + Math.random() * 0.01, lng: -122.4194 + Math.random() * 0.01 };
      
      await client.query(
        `INSERT INTO addresses (
          uid, user_id, street_address, unit_number, city, state, postal_code, country, 
          lat, lng, delivery_instructions, access_code, is_saved
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          pickup_address_id,
          req.user.uid,
          pickup_address.street_address,
          pickup_address.unit_number || null,
          pickup_address.city,
          pickup_address.state,
          pickup_address.postal_code,
          pickup_address.country || 'US',
          pickupCoordinates.lat,
          pickupCoordinates.lng,
          pickup_address.delivery_instructions || null,
          pickup_address.access_code || null,
          pickup_address.save_address || false
        ]
      );
    }
    
    // Process delivery address
    let delivery_address_id;
    if (delivery_address.use_saved_address_id) {
      // Verify this address belongs to the user
      const deliveryAddressCheck = await client.query(
        'SELECT uid FROM addresses WHERE uid = $1 AND user_id = $2',
        [delivery_address.use_saved_address_id, req.user.uid]
      );
      
      if (deliveryAddressCheck.rows.length === 0) {
        throw new Error('Invalid delivery address');
      }
      
      delivery_address_id = delivery_address.use_saved_address_id;
    } else {
      // Create a new address
      delivery_address_id = uuidv4();
      
      // If lat/lng not provided, we would normally use a geocoding API
      const deliveryCoordinates = delivery_address.lat && delivery_address.lng 
        ? { lat: delivery_address.lat, lng: delivery_address.lng } 
        : { lat: 37.7833 + Math.random() * 0.01, lng: -122.4167 + Math.random() * 0.01 };
      
      await client.query(
        `INSERT INTO addresses (
          uid, user_id, street_address, unit_number, city, state, postal_code, country, 
          lat, lng, delivery_instructions, access_code, is_saved
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          delivery_address_id,
          req.user.uid,
          delivery_address.street_address,
          delivery_address.unit_number || null,
          delivery_address.city,
          delivery_address.state,
          delivery_address.postal_code,
          delivery_address.country || 'US',
          deliveryCoordinates.lat,
          deliveryCoordinates.lng,
          delivery_address.delivery_instructions || null,
          delivery_address.access_code || null,
          delivery_address.save_address || false
        ]
      );
    }
    
    // Get addresses for distance calculation
    const pickupAddressResult = await client.query('SELECT lat, lng FROM addresses WHERE uid = $1', [pickup_address_id]);
    const deliveryAddressResult = await client.query('SELECT lat, lng FROM addresses WHERE uid = $1', [delivery_address_id]);
    
    const pickup_location = {
      lat: parseFloat(pickupAddressResult.rows[0].lat),
      lng: parseFloat(pickupAddressResult.rows[0].lng)
    };
    
    const delivery_location = {
      lat: parseFloat(deliveryAddressResult.rows[0].lat),
      lng: parseFloat(deliveryAddressResult.rows[0].lng)
    };
    
    // Calculate pricing
    const pricing = await calculateDeliveryCost({
      pickup_location,
      delivery_location,
      package_type_id: package.package_type_id,
      package_weight: package.weight || 0,
      priority_level: delivery_options.priority_level || 'standard'
    });
    
    // Validate promo code if provided
    let promo_code_id = null;
    if (payment.promo_code) {
      const promoResult = await validatePromoCode({ 
        code: payment.promo_code, 
        user_id: req.user.uid,
        order_amount: pricing.total
      });
      
      if (promoResult.valid) {
        promo_code_id = promoResult.promo_code.uid;
        pricing.discount = promoResult.promo_code.calculated_discount;
        pricing.total = parseFloat((pricing.total - promoResult.promo_code.calculated_discount).toFixed(2));
        if (pricing.total < 0) pricing.total = 0;
      }
    }
    
    // Create delivery record
    const delivery_uid = uuidv4();
    const now = new Date();
    const scheduled_pickup_time = delivery_options.scheduled_pickup_time ? new Date(delivery_options.scheduled_pickup_time) : now;
    
    // Calculate estimated delivery time
    const estimatedDeliveryTime = new Date(scheduled_pickup_time.getTime() + (pricing.estimated_duration * 60000));
    
    // Generate verification code for delivery (random 4-digit code)
    const verification_code = delivery_options.verification_code || Math.floor(1000 + Math.random() * 9000).toString();
    
    await client.query(
      `INSERT INTO deliveries (
        uid, sender_id, pickup_address_id, delivery_address_id, package_type_id,
        status, scheduled_pickup_time, estimated_delivery_time, package_description,
        package_weight, is_fragile, requires_signature, requires_id_verification,
        requires_photo_proof, recipient_name, recipient_phone, recipient_email,
        verification_code, special_instructions, distance, estimated_duration,
        priority_level, package_photo_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
      [
        delivery_uid,
        req.user.uid,
        pickup_address_id,
        delivery_address_id,
        package.package_type_id,
        'pending',
        scheduled_pickup_time,
        estimatedDeliveryTime,
        package.description,
        package.weight || null,
        package.is_fragile || false,
        delivery_options.requires_signature || false,
        delivery_options.requires_id_verification || false,
        delivery_options.requires_photo_proof !== false, // Default to true
        recipient.name,
        recipient.phone || null,
        recipient.email || null,
        verification_code,
        delivery_options.special_instructions || null,
        pricing.distance,
        pricing.estimated_duration,
        delivery_options.priority_level || 'standard',
        package.photo_url || null
      ]
    );
    
    // Create delivery items if provided
    if (package.items && Array.isArray(package.items)) {
      for (const item of package.items) {
        await client.query(
          `INSERT INTO delivery_items (
            uid, delivery_id, name, quantity, description, declared_value, photo_url
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidv4(),
            delivery_uid,
            item.name,
            item.quantity || 1,
            item.description || null,
            item.declared_value || null,
            item.photo_url || null
          ]
        );
      }
    }
    
    // Create delivery status update
    await client.query(
      `INSERT INTO delivery_status_updates (uid, delivery_id, status, updated_by, system_generated)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), delivery_uid, 'pending', req.user.uid, true]
    );
    
    // Create tracking links
    const recipientTrackingToken = await createTrackingLink(delivery_uid, true);
    const senderTrackingToken = await createTrackingLink(delivery_uid, false);
    
    // Process payment
    const payment_result = await processPayment({
      delivery_id: delivery_uid,
      sender_id: req.user.uid,
      payment_method_id: payment.payment_method_id,
      pricing,
      promo_code_id
    });
    
    // Set delivery status to searching for courier
    await client.query(
      'UPDATE deliveries SET status = $1, current_status_since = NOW() WHERE uid = $2',
      ['searching_courier', delivery_uid]
    );
    
    // Create delivery status update
    await client.query(
      `INSERT INTO delivery_status_updates (uid, delivery_id, status, updated_by, system_generated)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), delivery_uid, 'searching_courier', req.user.uid, true]
    );
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Create a notification for the sender
    await createNotification({
      user_id: req.user.uid,
      delivery_id: delivery_uid,
      type: 'status_update',
      title: 'Delivery Created',
      content: 'Your delivery has been created and we are searching for a courier.',
      action_url: `/deliveries/${delivery_uid}`
    });
    
    // Emit socket event to find couriers
    emitDeliveryRequestToNearby(delivery_uid);
    
    res.status(201).json({
      success: true,
      delivery: {
        uid: delivery_uid,
        status: 'searching_courier',
        created_at: now.toISOString(),
        scheduled_pickup_time: scheduled_pickup_time.toISOString(),
        estimated_delivery_time: estimatedDeliveryTime.toISOString(),
        tracking_code: senderTrackingToken,
        recipient_tracking_link: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/track/${recipientTrackingToken}`
      },
      payment: payment_result,
      message: 'Delivery created successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating delivery:', error);
    res.status(400).json({ success: false, error: parseError(error), message: 'Failed to create delivery' });
  } finally {
    client.release();
  }
});

/**
 * Emits delivery request notifications to nearby available couriers
 * 
 * @@need:external-api: Geospatial query service for finding nearby couriers efficiently
 * 
 * @param {string} delivery_id - The delivery ID to find couriers for
 */
async function emitDeliveryRequestToNearby(delivery_id) {
  const client = await pool.connect();
  try {
    // Get delivery details
    const deliveryResult = await client.query(`
      SELECT d.*, 
        pickup.lat as pickup_lat, pickup.lng as pickup_lng,
        pickup.city as pickup_city, pickup.street_address as pickup_street,
        drop_off.lat as dropoff_lat, drop_off.lng as dropoff_lng,
        drop_off.city as dropoff_city,
        pt.name as package_type_name, pt.uid as package_type_uid,
        pt.max_weight as max_weight
      FROM deliveries d
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses drop_off ON d.delivery_address_id = drop_off.uid
      JOIN package_types pt ON d.package_type_id = pt.uid
      WHERE d.uid = $1
    `, [delivery_id]);
    
    if (deliveryResult.rows.length === 0) {
      console.error('Delivery not found for courier matching:', delivery_id);
      return;
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Find nearby available couriers
    // In a real app, you'd use a geospatial query to find couriers efficiently
    const courierResult = await client.query(`
      SELECT cp.user_id, u.uid, cp.max_weight_capacity, cp.service_area_radius
      FROM courier_profiles cp
      JOIN users u ON cp.user_id = u.uid
      WHERE cp.is_available = true
        AND cp.active_delivery_id IS NULL
        AND cp.max_weight_capacity >= $1
    `, [delivery.max_weight]);
    
    // Calculate the earnings estimate
    const couriers = courierResult.rows;
    
    if (couriers.length === 0) {
      console.log('No available couriers found for delivery:', delivery_id);
      return;
    }
    
    // Get the commission rate from system settings
    const settingsResult = await client.query(
      "SELECT value FROM system_settings WHERE key = 'courier_commission_rate'"
    );
    const commission_rate = parseFloat(settingsResult.rows[0]?.value || 0.8);
    
    // Get payment info for delivery
    const paymentResult = await client.query(
      'SELECT amount FROM payments WHERE delivery_id = $1',
      [delivery_id]
    );
    
    if (paymentResult.rows.length === 0) {
      console.error('Payment not found for delivery:', delivery_id);
      return;
    }
    
    const payment_amount = parseFloat(paymentResult.rows[0].amount);
    const estimated_earnings = payment_amount * commission_rate;
    
    // Calculate expiration time (15 minutes from now)
    const expires_at = new Date();
    expires_at.setMinutes(expires_at.getMinutes() + 15);
    
    // Create delivery request object to send
    const deliveryRequest = {
      uid: delivery_id,
      created_at: delivery.created_at.toISOString(),
      expires_at: expires_at.toISOString(),
      scheduled_pickup_time: delivery.scheduled_pickup_time?.toISOString(),
      estimated_duration: delivery.estimated_duration,
      priority_level: delivery.priority_level,
      package_type: {
        uid: delivery.package_type_uid,
        name: delivery.package_type_name
      },
      pickup_address: {
        street_address: delivery.pickup_street.substring(0, 5) + '...', // Mask for privacy
        city: delivery.pickup_city,
        lat: parseFloat(delivery.pickup_lat),
        lng: parseFloat(delivery.pickup_lng)
      },
      delivery_address: {
        city: delivery.dropoff_city,
        lat: parseFloat(delivery.dropoff_lat),
        lng: parseFloat(delivery.dropoff_lng)
      },
      distance: {
        pickup_distance: 0, // In a real app, calculated for each courier
        total_distance: parseFloat(delivery.distance)
      },
      earnings: {
        estimated_total: parseFloat(estimated_earnings.toFixed(2))
      }
    };
    
    // Emit the delivery request to each courier
    for (const courier of couriers) {
      // In a real app, you'd filter by distance to pickup and calculate specific pickup_distance
      // For demo purposes, we'll send to all available couriers
      io.to(`user:${courier.user_id}`).emit('delivery_request', {
        delivery_request: deliveryRequest
      });
      
      console.log(`Delivery request ${delivery_id} sent to courier ${courier.user_id}`);
    }
    
  } catch (error) {
    console.error('Error emitting delivery request to couriers:', error);
  } finally {
    client.release();
  }
}

app.get('/api/deliveries', authenticateToken, async (req, res) => {
  const { status, start_date, end_date, page = 1, limit = 10 } = req.query;
  
  // Calculate pagination
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  // Build query filters
  const filters = [];
  const values = [];
  let paramCount = 1;
  
  // Add user type filter
  if (req.user.user_type === 'sender') {
    filters.push(`d.sender_id = $${paramCount++}`);
    values.push(req.user.uid);
  } else if (req.user.user_type === 'courier') {
    filters.push(`d.courier_id = $${paramCount++}`);
    values.push(req.user.uid);
  }
  
  // Add status filter if provided
  if (status) {
    const statusList = status.split(',').map(s => s.trim());
    filters.push(`d.status IN (${statusList.map((_, i) => `$${paramCount + i}`).join(', ')})`);
    values.push(...statusList);
    paramCount += statusList.length;
  }
  
  // Add date filters if provided
  if (start_date) {
    filters.push(`d.created_at >= $${paramCount++}`);
    values.push(new Date(start_date));
  }
  
  if (end_date) {
    filters.push(`d.created_at <= $${paramCount++}`);
    values.push(new Date(end_date));
  }
  
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  
  const client = await pool.connect();
  try {
    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM deliveries d
      ${whereClause}
    `;
    
    const countResult = await client.query(countQuery, values);
    const totalItems = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalItems / parseInt(limit));
    
    // Get deliveries
    const query = `
      SELECT d.uid, d.status, d.created_at, d.scheduled_pickup_time, 
        d.actual_pickup_time, d.estimated_delivery_time, d.actual_delivery_time, 
        d.recipient_name, d.distance, d.priority_level,
        pt.uid AS package_type_uid, pt.name AS package_type_name, pt.icon_url,
        pickup.street_address AS pickup_street, pickup.unit_number AS pickup_unit,
        pickup.city AS pickup_city, pickup.state AS pickup_state, pickup.postal_code AS pickup_postal,
        dropoff.street_address AS dropoff_street, dropoff.unit_number AS dropoff_unit,
        dropoff.city AS dropoff_city, dropoff.state AS dropoff_state, dropoff.postal_code AS dropoff_postal,
        p.uid AS payment_uid, p.status AS payment_status, p.amount AS payment_amount,
        cu.uid AS courier_uid, cu.first_name AS courier_first_name, cu.last_name AS courier_last_name,
        cu.profile_picture_url AS courier_picture, cu.average_rating AS courier_rating
      FROM deliveries d
      JOIN package_types pt ON d.package_type_id = pt.uid
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      LEFT JOIN payments p ON d.uid = p.delivery_id
      LEFT JOIN users cu ON d.courier_id = cu.uid
      ${whereClause}
      ORDER BY d.created_at DESC
      LIMIT $${paramCount++} OFFSET $${paramCount++}
    `;
    
    values.push(parseInt(limit), offset);
    
    const result = await client.query(query, values);
    
    // Format response
    const deliveries = result.rows.map(row => {
      const delivery = {
        uid: row.uid,
        status: row.status,
        created_at: row.created_at,
        scheduled_pickup_time: row.scheduled_pickup_time,
        actual_pickup_time: row.actual_pickup_time,
        estimated_delivery_time: row.estimated_delivery_time,
        actual_delivery_time: row.actual_delivery_time,
        package_type: {
          uid: row.package_type_uid,
          name: row.package_type_name,
          icon_url: row.icon_url
        },
        pickup_address: {
          street_address: row.pickup_street,
          unit_number: row.pickup_unit,
          city: row.pickup_city,
          state: row.pickup_state,
          postal_code: row.pickup_postal
        },
        delivery_address: {
          street_address: row.dropoff_street,
          unit_number: row.dropoff_unit,
          city: row.dropoff_city,
          state: row.dropoff_state,
          postal_code: row.dropoff_postal
        },
        recipient_name: row.recipient_name,
        distance: parseFloat(row.distance),
        priority_level: row.priority_level,
        payment: {
          uid: row.payment_uid,
          status: row.payment_status,
          amount: parseFloat(row.payment_amount)
        }
      };
      
      // Add courier info if assigned
      if (row.courier_uid) {
        delivery.courier = {
          uid: row.courier_uid,
          first_name: row.courier_first_name,
          last_name: row.courier_last_name,
          profile_picture_url: row.courier_picture,
          average_rating: parseFloat(row.courier_rating)
        };
      }
      
      return delivery;
    });
    
    res.json({
      deliveries,
      pagination: {
        total_items: totalItems,
        total_pages: totalPages,
        current_page: parseInt(page),
        has_next_page: parseInt(page) < totalPages,
        has_prev_page: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Error fetching deliveries:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/deliveries/:id', async (req, res) => {
  const delivery_id = req.params.id;
  const { tracking_token } = req.query;
  
  let user_id = null;
  let is_tracking_token = false;
  
  // Check authorization
  if (tracking_token) {
    // Validate tracking token
    const delivery = await validateTrackingToken(tracking_token);
    if (!delivery) {
      return res.status(401).json({ success: false, error: 'Invalid token', message: 'The tracking token is invalid or expired' });
    }
    
    is_tracking_token = true;
    // Continue with delivery_id from the validated token
  } else {
    // Check JWT authentication
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Access denied', message: 'Authentication token required' });
    }
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
      user_id = decoded.uid;
    } catch (error) {
      return res.status(403).json({ success: false, error: 'Invalid token', message: 'Token is invalid or expired' });
    }
  }
  
  const client = await pool.connect();
  try {
    // Get delivery with related data
    const result = await client.query(`
      SELECT d.*,
        pt.uid AS package_type_uid, pt.name AS package_type_name, pt.description AS package_type_description, pt.icon_url,
        pickup.uid AS pickup_uid, pickup.street_address AS pickup_street, pickup.unit_number AS pickup_unit,
        pickup.city AS pickup_city, pickup.state AS pickup_state, pickup.postal_code AS pickup_postal,
        pickup.country AS pickup_country, pickup.lat AS pickup_lat, pickup.lng AS pickup_lng,
        pickup.delivery_instructions AS pickup_instructions, pickup.access_code AS pickup_access_code,
        dropoff.uid AS dropoff_uid, dropoff.street_address AS dropoff_street, dropoff.unit_number AS dropoff_unit,
        dropoff.city AS dropoff_city, dropoff.state AS dropoff_state, dropoff.postal_code AS dropoff_postal,
        dropoff.country AS dropoff_country, dropoff.lat AS dropoff_lat, dropoff.lng AS dropoff_lng,
        dropoff.delivery_instructions AS dropoff_instructions, dropoff.access_code AS dropoff_access_code,
        sender.uid AS sender_uid, sender.first_name AS sender_first_name, sender.last_name AS sender_last_name,
        sender.profile_picture_url AS sender_picture, sender.average_rating AS sender_rating,
        courier.uid AS courier_uid, courier.first_name AS courier_first_name, courier.last_name AS courier_last_name,
        courier.profile_picture_url AS courier_picture, courier.average_rating AS courier_rating,
        p.uid AS payment_uid, p.status AS payment_status, p.amount AS payment_amount, p.tip_amount,
        p.base_fee, p.distance_fee, p.weight_fee, p.priority_fee, p.tax, p.discount_amount,
        v.type AS vehicle_type, v.color AS vehicle_color, v.make AS vehicle_make, v.model AS vehicle_model
      FROM deliveries d
      JOIN package_types pt ON d.package_type_id = pt.uid
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      JOIN users sender ON d.sender_id = sender.uid
      LEFT JOIN users courier ON d.courier_id = courier.uid
      LEFT JOIN payments p ON d.uid = p.delivery_id
      LEFT JOIN courier_profiles cp ON courier.uid = cp.user_id
      LEFT JOIN vehicles v ON cp.uid = v.courier_id
      WHERE d.uid = $1
    `, [delivery_id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery not found' });
    }
    
    const row = result.rows[0];
    
    // Check access permissions
    if (!is_tracking_token && user_id !== row.sender_id && user_id !== row.courier_id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this delivery' });
    }
    
    // Get delivery items
    const itemsResult = await client.query(
      'SELECT * FROM delivery_items WHERE delivery_id = $1',
      [delivery_id]
    );
    
    // Get status history
    const statusResult = await client.query(`
      SELECT dsu.status, dsu.timestamp, dsu.latitude, dsu.longitude, dsu.notes
      FROM delivery_status_updates dsu
      WHERE dsu.delivery_id = $1
      ORDER BY dsu.timestamp
    `, [delivery_id]);
    
    // Get ratings if delivery is completed
    let sender_rating = null;
    let courier_rating = null;
    
    if (row.status === 'delivered') {
      const ratingsResult = await client.query(`
        SELECT r.*, u.user_type
        FROM ratings r
        JOIN users u ON r.rater_id = u.uid
        WHERE r.delivery_id = $1
      `, [delivery_id]);
      
      for (const rating of ratingsResult.rows) {
        if (rating.user_type === 'sender') {
          courier_rating = {
            rating: rating.rating,
            timeliness_rating: rating.timeliness_rating,
            communication_rating: rating.communication_rating,
            handling_rating: rating.handling_rating,
            comment: rating.comment,
            created_at: rating.created_at
          };
        } else if (rating.user_type === 'courier') {
          sender_rating = {
            rating: rating.rating,
            comment: rating.comment,
            created_at: rating.created_at
          };
        }
      }
    }
    
    // Create response object
    const delivery = {
      uid: row.uid,
      status: row.status,
      created_at: row.created_at,
      scheduled_pickup_time: row.scheduled_pickup_time,
      actual_pickup_time: row.actual_pickup_time,
      estimated_delivery_time: row.estimated_delivery_time,
      actual_delivery_time: row.actual_delivery_time,
      package_description: row.package_description,
      package_weight: row.package_weight ? parseFloat(row.package_weight) : null,
      is_fragile: row.is_fragile,
      package_photo_url: row.package_photo_url,
      delivery_proof_url: row.delivery_proof_url,
      requires_signature: row.requires_signature,
      requires_id_verification: row.requires_id_verification,
      requires_photo_proof: row.requires_photo_proof,
      special_instructions: row.special_instructions,
      distance: parseFloat(row.distance),
      estimated_duration: parseInt(row.estimated_duration),
      priority_level: row.priority_level,
      package_type: {
        uid: row.package_type_uid,
        name: row.package_type_name,
        description: row.package_type_description,
        icon_url: row.icon_url
      },
      pickup_address: {
        street_address: row.pickup_street,
        unit_number: row.pickup_unit,
        city: row.pickup_city,
        state: row.pickup_state,
        postal_code: row.pickup_postal,
        country: row.pickup_country,
        lat: parseFloat(row.pickup_lat),
        lng: parseFloat(row.pickup_lng),
        delivery_instructions: row.pickup_instructions
      },
      delivery_address: {
        street_address: row.dropoff_street,
        unit_number: row.dropoff_unit,
        city: row.dropoff_city,
        state: row.dropoff_state,
        postal_code: row.dropoff_postal,
        country: row.dropoff_country,
        lat: parseFloat(row.dropoff_lat),
        lng: parseFloat(row.dropoff_lng),
        delivery_instructions: row.dropoff_instructions
      },
      sender: {
        uid: row.sender_uid,
        first_name: row.sender_first_name,
        last_name: row.sender_last_name,
        profile_picture_url: row.sender_picture,
        average_rating: parseFloat(row.sender_rating)
      },
      recipient: {
        name: row.recipient_name,
        phone: row.recipient_phone,
        email: row.recipient_email
      },
      items: itemsResult.rows.map(item => ({
        uid: item.uid,
        name: item.name,
        quantity: item.quantity,
        description: item.description,
        declared_value: item.declared_value ? parseFloat(item.declared_value) : null,
        photo_url: item.photo_url
      })),
      status_history: statusResult.rows.map(status => ({
        status: status.status,
        timestamp: status.timestamp,
        notes: status.notes,
        location: status.latitude && status.longitude ? {
          lat: parseFloat(status.latitude),
          lng: parseFloat(status.longitude)
        } : null
      }))
    };
    
    // Add payment information
    if (row.payment_uid) {
      delivery.payment = {
        uid: row.payment_uid,
        status: row.payment_status,
        amount: parseFloat(row.payment_amount),
        tip_amount: parseFloat(row.tip_amount),
        breakdown: {
          base_fee: parseFloat(row.base_fee),
          distance_fee: parseFloat(row.distance_fee),
          weight_fee: parseFloat(row.weight_fee),
          priority_fee: parseFloat(row.priority_fee),
          tax: parseFloat(row.tax),
          discount: parseFloat(row.discount_amount || 0),
          total: parseFloat(row.payment_amount)
        }
      };
    }
    
    // Add courier information if assigned
    if (row.courier_uid) {
      delivery.courier = {
        uid: row.courier_uid,
        first_name: row.courier_first_name,
        last_name: row.courier_last_name,
        profile_picture_url: row.courier_picture,
        average_rating: parseFloat(row.courier_rating) || null,
        vehicle: row.vehicle_type ? {
          type: row.vehicle_type,
          color: row.vehicle_color,
          make: row.vehicle_make,
          model: row.vehicle_model
        } : null
      };
    }
    
    // Add ratings if available
    if (sender_rating || courier_rating) {
      delivery.ratings = {};
      if (sender_rating) delivery.ratings.sender_rating = sender_rating;
      if (courier_rating) delivery.ratings.courier_rating = courier_rating;
    }
    
    // Add verification code only for courier
    if (!is_tracking_token && user_id === row.courier_id) {
      delivery.verification_code = row.verification_code;
      
      // Add access codes only for courier
      if (row.pickup_access_code) {
        delivery.pickup_address.access_code = row.pickup_access_code;
      }
      
      if (row.dropoff_access_code) {
        delivery.delivery_address.access_code = row.dropoff_access_code;
      }
    }
    
    // Add tracking links only for sender
    if (!is_tracking_token && user_id === row.sender_id) {
      const trackingLinksResult = await client.query(`
        SELECT token, is_recipient_link FROM delivery_tracking_links WHERE delivery_id = $1
      `, [delivery_id]);
      
      const trackingLinks = {};
      for (const link of trackingLinksResult.rows) {
        if (link.is_recipient_link) {
          trackingLinks.recipient_link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/track/${link.token}`;
        } else {
          trackingLinks.sender_link = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/track/${link.token}`;
        }
      }
      
      if (Object.keys(trackingLinks).length > 0) {
        delivery.tracking_links = trackingLinks;
      }
    }
    
    res.json({ delivery });
  } catch (error) {
    console.error('Error fetching delivery details:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/deliveries/:id/cancel', authenticateToken, senderOnly, async (req, res) => {
  const delivery_id = req.params.id;
  const { reason } = req.body;
  
  const client = await pool.connect();
  try {
    // Check if delivery belongs to user and is in a cancellable state
    const deliveryResult = await client.query(
      `SELECT * FROM deliveries WHERE uid = $1 AND sender_id = $2 
       AND status IN ('pending', 'searching_courier', 'courier_assigned', 'en_route_to_pickup')`,
      [delivery_id, req.user.uid]
    );
    
    if (deliveryResult.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Not cancellable', message: 'Delivery not found or cannot be cancelled' });
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Get payment info
    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE delivery_id = $1',
      [delivery_id]
    );
    
    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Payment not found', message: 'Cannot cancel delivery without payment information' });
    }
    
    const payment = paymentResult.rows[0];
    
    // Determine refund amount based on delivery status
    let refundAmount = 0;
    let refundReason = reason || 'Cancelled by sender';
    
    switch (delivery.status) {
      case 'pending':
      case 'searching_courier':
        // Full refund
        refundAmount = parseFloat(payment.amount);
        break;
      case 'courier_assigned':
      case 'en_route_to_pickup':
        // Partial refund (deduct cancellation fee)
        const cancellationFee = Math.min(5.00, parseFloat(payment.amount) * 0.15); // $5 or 15%, whichever is less
        refundAmount = parseFloat(payment.amount) - cancellationFee;
        refundReason += ' (cancellation fee applied)';
        break;
      default:
        // Should not reach here based on the query filter
        refundAmount = 0;
    }
    
    // Update delivery
    await client.query(
      'UPDATE deliveries SET status = $1, cancellation_reason = $2, current_status_since = NOW() WHERE uid = $3',
      ['cancelled', reason || 'Cancelled by sender', delivery_id]
    );
    
    // Create status update
    await client.query(
      `INSERT INTO delivery_status_updates (uid, delivery_id, status, notes, updated_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [uuidv4(), delivery_id, 'cancelled', reason, req.user.uid]
    );
    
    // Update payment
    await client.query(
      `UPDATE payments SET status = $1, refund_amount = $2, refund_reason = $3 WHERE uid = $4`,
      ['refunded', refundAmount, refundReason, payment.uid]
    );
    
    // If courier was assigned, update their profile
    if (delivery.courier_id) {
      await client.query(
        'UPDATE courier_profiles SET active_delivery_id = NULL, cancelled_deliveries = cancelled_deliveries + 1 WHERE user_id = $1',
        [delivery.courier_id]
      );
      
      // Create notification for courier
      await createNotification({
        user_id: delivery.courier_id,
        delivery_id,
        type: 'status_update',
        title: 'Delivery Cancelled',
        content: `The delivery has been cancelled by the sender. ${reason ? `Reason: ${reason}` : ''}`,
        action_url: `/deliveries/${delivery_id}`
      });
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.json({
      success: true,
      delivery: {
        uid: delivery_id,
        status: 'cancelled',
        cancellation_reason: reason
      },
      refund: {
        processed: true,
        amount: refundAmount,
        status: 'processed'
      },
      message: 'Delivery cancelled successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error cancelling delivery:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/deliveries/:id/tip', authenticateToken, senderOnly, async (req, res) => {
  const delivery_id = req.params.id;
  const { tip_amount } = req.body;
  
  if (tip_amount === undefined || tip_amount < 0) {
    return res.status(400).json({ success: false, error: 'Invalid tip', message: 'Tip amount must be a non-negative number' });
  }
  
  const client = await pool.connect();
  try {
    // Check if delivery belongs to user and is completed
    const deliveryResult = await client.query(
      'SELECT * FROM deliveries WHERE uid = $1 AND sender_id = $2 AND status = $3',
      [delivery_id, req.user.uid, 'delivered']
    );
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery not found or not eligible for tipping' });
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Get current payment
    const paymentResult = await client.query(
      'SELECT * FROM payments WHERE delivery_id = $1',
      [delivery_id]
    );
    
    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Payment not found', message: 'Payment record not found for this delivery' });
    }
    
    const payment = paymentResult.rows[0];
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Calculate new total amount
    const baseAmount = parseFloat(payment.amount) - parseFloat(payment.tip_amount);
    const newTipAmount = parseFloat(tip_amount);
    const newTotalAmount = baseAmount + newTipAmount;
    
    // Update payment
    await client.query(
      'UPDATE payments SET amount = $1, tip_amount = $2, updated_at = NOW() WHERE uid = $3',
      [newTotalAmount, newTipAmount, payment.uid]
    );
    
    // If courier exists, update their balance
    if (delivery.courier_id) {
      // Calculate tip difference
      const tipDifference = newTipAmount - parseFloat(payment.tip_amount);
      
      if (tipDifference !== 0) {
        await client.query(
          'UPDATE users SET account_balance = account_balance + $1 WHERE uid = $2',
          [tipDifference, delivery.courier_id]
        );
        
        // Create notification for courier if tip was added or increased
        if (tipDifference > 0) {
          await createNotification({
            user_id: delivery.courier_id,
            delivery_id,
            type: 'payment',
            title: 'You received a tip!',
            content: `You received a $${tipDifference.toFixed(2)} tip for your delivery.`,
            action_url: `/deliveries/${delivery_id}`
          });
        }
      }
    }
    
    // Process payment for the additional tip amount
    // In a real app, you'd capture the additional payment or create a new charge
    // For this demo, we'll just update the data
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.json({
      success: true,
      payment: {
        uid: payment.uid,
        tip_amount: newTipAmount,
        total_amount: newTotalAmount
      },
      message: 'Tip updated successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating tip:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/deliveries/:id/rate', authenticateToken, async (req, res) => {
  const delivery_id = req.params.id;
  const { 
    rating, comment, timeliness_rating, communication_rating, 
    handling_rating, issue_reported, issue_type, issue_description 
  } = req.body;
  
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ success: false, error: 'Invalid rating', message: 'Rating must be between 1 and 5' });
  }
  
  const client = await pool.connect();
  try {
    // Check if delivery exists and is completed
    const deliveryResult = await client.query(
      'SELECT * FROM deliveries WHERE uid = $1 AND status = $2 AND (sender_id = $3 OR courier_id = $3)',
      [delivery_id, 'delivered', req.user.uid]
    );
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery not found or not eligible for rating' });
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Determine who is rating whom
    let rater_id, ratee_id;
    
    if (req.user.uid === delivery.sender_id) {
      rater_id = delivery.sender_id;
      ratee_id = delivery.courier_id;
      
      // If sender is rating, validate courier-specific ratings if provided
      if ((timeliness_rating && (timeliness_rating < 1 || timeliness_rating > 5)) ||
          (communication_rating && (communication_rating < 1 || communication_rating > 5)) ||
          (handling_rating && (handling_rating < 1 || handling_rating > 5))) {
        return res.status(400).json({ success: false, error: 'Invalid rating', message: 'All ratings must be between 1 and 5' });
      }
    } else if (req.user.uid === delivery.courier_id) {
      rater_id = delivery.courier_id;
      ratee_id = delivery.sender_id;
      
      // Couriers don't provide category ratings
      if (timeliness_rating || communication_rating || handling_rating) {
        return res.status(400).json({ success: false, error: 'Invalid rating', message: 'Courier can only provide overall rating' });
      }
    } else {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'You are not authorized to rate this delivery' });
    }
    
    // Check if user has already rated this delivery
    const existingRatingResult = await client.query(
      'SELECT * FROM ratings WHERE delivery_id = $1 AND rater_id = $2',
      [delivery_id, rater_id]
    );
    
    if (existingRatingResult.rows.length > 0) {
      return res.status(400).json({ success: false, error: 'Already rated', message: 'You have already rated this delivery' });
    }
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Create rating
    const rating_uid = uuidv4();
    await client.query(
      `INSERT INTO ratings (
        uid, delivery_id, rater_id, ratee_id, rating, comment, 
        timeliness_rating, communication_rating, handling_rating,
        issue_reported, issue_type, issue_description
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        rating_uid,
        delivery_id,
        rater_id,
        ratee_id,
        rating,
        comment || null,
        timeliness_rating || null,
        communication_rating || null,
        handling_rating || null,
        issue_reported || false,
        issue_type || null,
        issue_description || null
      ]
    );
    
    // Update user's average rating
    // Get all ratings for the ratee
    const ratingsResult = await client.query(
      'SELECT rating FROM ratings WHERE ratee_id = $1',
      [ratee_id]
    );
    
    const ratings = ratingsResult.rows.map(r => parseFloat(r.rating));
    const averageRating = ratings.reduce((sum, r) => sum + r, 0) / ratings.length;
    
    // Update user record
    await client.query(
      'UPDATE users SET average_rating = $1, total_ratings = $2 WHERE uid = $3',
      [averageRating.toFixed(2), ratings.length, ratee_id]
    );
    
    // If issue was reported, create an issue record
    if (issue_reported && (issue_type || issue_description)) {
      const issue_uid = uuidv4();
      await client.query(
        `INSERT INTO delivery_issues (
          uid, delivery_id, reported_by_id, issue_type, description, status
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          issue_uid,
          delivery_id,
          rater_id,
          issue_type || 'other',
          issue_description || 'Issue reported through rating',
          'reported'
        ]
      );
    }
    
    // Create notification for the ratee
    await createNotification({
      user_id: ratee_id,
      delivery_id,
      type: 'rating',
      title: 'New Rating Received',
      content: `You received a ${rating}-star rating for your delivery.`,
      action_url: `/deliveries/${delivery_id}`
    });
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.status(201).json({
      success: true,
      rating: {
        uid: rating_uid,
        delivery_id,
        rating,
        comment,
        timeliness_rating,
        communication_rating,
        handling_rating,
        issue_reported: issue_reported || false,
        created_at: new Date().toISOString()
      },
      message: 'Rating submitted successfully'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error submitting rating:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/deliveries/:id/report-issue', authenticateToken, async (req, res) => {
  const delivery_id = req.params.id;
  const { issue_type, description, photos } = req.body;
  
  if (!issue_type || !description) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Issue type and description are required' });
  }
  
  const client = await pool.connect();
  try {
    // Check if delivery exists and user is related to it
    const deliveryResult = await client.query(
      'SELECT * FROM deliveries WHERE uid = $1 AND (sender_id = $2 OR courier_id = $2)',
      [delivery_id, req.user.uid]
    );
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery not found' });
    }
    
    // Create issue
    const issue_uid = uuidv4();
    const photosJson = photos && photos.length > 0 ? JSON.stringify(photos) : null;
    
    await client.query(
      `INSERT INTO delivery_issues (
        uid, delivery_id, reported_by_id, issue_type, description, status, photos_url
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        issue_uid,
        delivery_id,
        req.user.uid,
        issue_type,
        description,
        'reported',
        photosJson
      ]
    );
    
    // Create notification for admin (in a real app)
    // For this demo, we'll just log it
    console.log(`[MOCK] Issue reported for delivery ${delivery_id}: ${issue_type} - ${description}`);
    
    // Create notification for the other party in the delivery
    const delivery = deliveryResult.rows[0];
    const otherPartyId = req.user.uid === delivery.sender_id ? delivery.courier_id : delivery.sender_id;
    
    if (otherPartyId) {
      await createNotification({
        user_id: otherPartyId,
        delivery_id,
        type: 'status_update',
        title: 'Issue Reported',
        content: `An issue has been reported with your delivery: ${issue_type}`,
        action_url: `/deliveries/${delivery_id}`
      });
    }
    
    res.status(201).json({
      success: true,
      issue: {
        uid: issue_uid,
        issue_type,
        status: 'reported',
        created_at: new Date().toISOString()
      },
      message: 'Issue reported successfully'
    });
  } catch (error) {
    console.error('Error reporting issue:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/deliveries/:id/receipt', authenticateToken, async (req, res) => {
  const delivery_id = req.params.id;
  const format = req.query.format || 'json';
  
  const client = await pool.connect();
  try {
    // Check if delivery exists and user has permission
    const deliveryResult = await client.query(`
      SELECT d.*,
        sender.first_name AS sender_first_name, sender.last_name AS sender_last_name,
        pickup.street_address AS pickup_street, pickup.unit_number AS pickup_unit,
        pickup.city AS pickup_city, pickup.state AS pickup_state, pickup.postal_code AS pickup_postal,
        dropoff.street_address AS dropoff_street, dropoff.unit_number AS dropoff_unit,
        dropoff.city AS dropoff_city, dropoff.state AS dropoff_state, dropoff.postal_code AS dropoff_postal,
        pt.name AS package_type_name,
        p.uid AS payment_uid, p.amount, p.base_fee, p.distance_fee, p.weight_fee, 
        p.priority_fee, p.tax, p.tip_amount, p.discount_amount, p.promo_code_id,
        pm.payment_type, pm.provider, pm.last_four
      FROM deliveries d
      JOIN users sender ON d.sender_id = sender.uid
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      JOIN package_types pt ON d.package_type_id = pt.uid
      LEFT JOIN payments p ON d.uid = p.delivery_id
      LEFT JOIN payment_methods pm ON p.payment_method_id = pm.uid
      WHERE d.uid = $1 AND (d.sender_id = $2 OR d.courier_id = $2) AND d.status = 'delivered'
    `, [delivery_id, req.user.uid]);
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery receipt not found or not available' });
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Get promo code details if used
    let promoCode = null;
    if (delivery.promo_code_id) {
      const promoResult = await client.query(
        'SELECT code FROM promo_codes WHERE uid = $1',
        [delivery.promo_code_id]
      );
      
      if (promoResult.rows.length > 0) {
        promoCode = {
          code: promoResult.rows[0].code,
          discount_amount: parseFloat(delivery.discount_amount || 0)
        };
      }
    }
    
    // Format receipt data
    const receipt = {
      receipt_number: `RCT-${delivery_id.slice(-8)}`,
      date: delivery.actual_delivery_time,
      delivery: {
        uid: delivery.uid,
        pickup_address: {
          street_address: delivery.pickup_street,
          unit_number: delivery.pickup_unit,
          city: delivery.pickup_city,
          state: delivery.pickup_state,
          postal_code: delivery.pickup_postal
        },
        delivery_address: {
          street_address: delivery.dropoff_street,
          unit_number: delivery.dropoff_unit,
          city: delivery.dropoff_city,
          state: delivery.dropoff_state,
          postal_code: delivery.dropoff_postal
        },
        package_type: delivery.package_type_name,
        distance: parseFloat(delivery.distance),
        priority_level: delivery.priority_level,
        pickup_time: delivery.actual_pickup_time,
        delivery_time: delivery.actual_delivery_time
      },
      payment: {
        payment_method: {
          type: delivery.payment_type,
          provider: delivery.provider,
          last_four: delivery.last_four
        },
        breakdown: {
          base_fee: parseFloat(delivery.base_fee),
          distance_fee: parseFloat(delivery.distance_fee),
          weight_fee: parseFloat(delivery.weight_fee),
          priority_fee: parseFloat(delivery.priority_fee),
          subtotal: parseFloat(delivery.base_fee) + parseFloat(delivery.distance_fee) + 
                   parseFloat(delivery.weight_fee) + parseFloat(delivery.priority_fee),
          tax: parseFloat(delivery.tax),
          discount: parseFloat(delivery.discount_amount || 0),
          tip: parseFloat(delivery.tip_amount),
          total: parseFloat(delivery.amount)
        }
      },
      company_details: {
        name: "FlashDrop",
        address: "123 Delivery St, San Francisco, CA 94105",
        tax_id: "12-3456789",
        support_email: "support@flashdrop.com",
        support_phone: "1-800-FLASH-DROP"
      }
    };
    
    // Add promo code if used
    if (promoCode) {
      receipt.payment.promo_applied = promoCode;
    }
    
    if (format === 'pdf') {
      // @@need:external-api: PDF generation service
      
      // For this demo, we'll just return a message that PDF generation is not implemented
      return res.status(400).json({ 
        success: false, 
        error: 'PDF generation not implemented', 
        message: 'PDF generation is not available in this demo'
      });
    }
    
    res.json({ receipt });
  } catch (error) {
    console.error('Error generating receipt:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Courier routes
app.put('/api/courier/availability', authenticateToken, courierOnly, async (req, res) => {
  const { is_available, current_location } = req.body;
  
  if (is_available === undefined) {
    return res.status(400).json({ success: false, error: 'Missing required fields', message: 'Availability status is required' });
  }
  
  const client = await pool.connect();
  try {
    let updateFields = ['is_available = $1'];
    let values = [is_available];
    let paramCount = 2;
    
    // Add location update if provided
    if (current_location) {
      if (!current_location.lat || !current_location.lng) {
        return res.status(400).json({ success: false, error: 'Invalid location', message: 'Location must include lat and lng' });
      }
      
      updateFields.push('current_location_lat = $' + paramCount++);
      updateFields.push('current_location_lng = $' + paramCount++);
      updateFields.push('location_updated_at = NOW()');
      
      values.push(current_location.lat);
      values.push(current_location.lng);
    }
    
    values.push(req.user.uid);
    
    // Update courier profile
    const query = `
      UPDATE courier_profiles SET ${updateFields.join(', ')}
      WHERE user_id = $${paramCount}
      RETURNING *
    `;
    
    const result = await client.query(query, values);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Courier profile not found' });
    }
    
    // If going online, create a location update record
    if (is_available && current_location) {
      await client.query(
        `INSERT INTO location_updates (uid, user_id, latitude, longitude)
         VALUES ($1, $2, $3, $4)`,
        [uuidv4(), req.user.uid, current_location.lat, current_location.lng]
      );
    }
    
    const profile = result.rows[0];
    
    res.json({
      success: true,
      courier_profile: {
        is_available: profile.is_available,
        current_location_lat: parseFloat(profile.current_location_lat),
        current_location_lng: parseFloat(profile.current_location_lng),
        location_updated_at: profile.location_updated_at
      },
      message: `You are now ${is_available ? 'online' : 'offline'}`
    });
    
    // If going online, check for nearby delivery requests
    if (is_available) {
      // Query for pending deliveries and emit to courier
      // This would normally be a geospatial query
      // For this demo, we'll just log that this would happen
      console.log(`[MOCK] Checking for nearby delivery requests for courier ${req.user.uid}`);
    }
  } catch (error) {
    console.error('Error updating courier availability:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/courier/location', authenticateToken, courierOnly, async (req, res) => {
  const { location, delivery_id, battery_level, device_info } = req.body;
  
  if (!location || !location.lat || !location.lng) {
    return res.status(400).json({ success: false, error: 'Invalid location', message: 'Valid location coordinates are required' });
  }
  
  try {
    const result = await updateCourierLocation(req.user.uid, {
      location,
      delivery_id,
      battery_level,
      device_info
    });
    
    res.json({
      success: true,
      location_update: result,
      message: 'Location updated successfully'
    });
  } catch (error) {
    console.error('Error updating courier location:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  }
});

app.get('/api/courier/active-delivery', authenticateToken, courierOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    // Get active delivery ID from courier profile
    const profileResult = await client.query(
      'SELECT active_delivery_id FROM courier_profiles WHERE user_id = $1',
      [req.user.uid]
    );
    
    if (profileResult.rows.length === 0 || !profileResult.rows[0].active_delivery_id) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'No active delivery found' });
    }
    
    const delivery_id = profileResult.rows[0].active_delivery_id;
    
    // Get delivery details using the common delivery details endpoint logic
    const deliveryResult = await client.query(`
      SELECT d.*,
        pt.uid AS package_type_uid, pt.name AS package_type_name, pt.description AS package_type_description, pt.icon_url,
        pickup.uid AS pickup_uid, pickup.street_address AS pickup_street, pickup.unit_number AS pickup_unit,
        pickup.city AS pickup_city, pickup.state AS pickup_state, pickup.postal_code AS pickup_postal,
        pickup.country AS pickup_country, pickup.lat AS pickup_lat, pickup.lng AS pickup_lng,
        pickup.delivery_instructions AS pickup_instructions, pickup.access_code AS pickup_access_code,
        dropoff.uid AS dropoff_uid, dropoff.street_address AS dropoff_street, dropoff.unit_number AS dropoff_unit,
        dropoff.city AS dropoff_city, dropoff.state AS dropoff_state, dropoff.postal_code AS dropoff_postal,
        dropoff.country AS dropoff_country, dropoff.lat AS dropoff_lat, dropoff.lng AS dropoff_lng,
        dropoff.delivery_instructions AS dropoff_instructions, dropoff.access_code AS dropoff_access_code,
        sender.uid AS sender_uid, sender.first_name AS sender_first_name, sender.last_name AS sender_last_name,
        sender.profile_picture_url AS sender_picture, sender.average_rating AS sender_rating,
        p.uid AS payment_uid, p.status AS payment_status, p.amount AS payment_amount, p.tip_amount,
        p.base_fee, p.distance_fee, p.weight_fee, p.priority_fee, p.tax, p.discount_amount
      FROM deliveries d
      JOIN package_types pt ON d.package_type_id = pt.uid
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      JOIN users sender ON d.sender_id = sender.uid
      LEFT JOIN payments p ON d.uid = p.delivery_id
      WHERE d.uid = $1 AND d.courier_id = $2
    `, [delivery_id, req.user.uid]);
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Active delivery not found' });
    }
    
    const row = deliveryResult.rows[0];
    
    // Get delivery items
    const itemsResult = await client.query(
      'SELECT * FROM delivery_items WHERE delivery_id = $1',
      [delivery_id]
    );
    
    // Get status history
    const statusResult = await client.query(`
      SELECT dsu.status, dsu.timestamp, dsu.latitude, dsu.longitude, dsu.notes
      FROM delivery_status_updates dsu
      WHERE dsu.delivery_id = $1
      ORDER BY dsu.timestamp
    `, [delivery_id]);
    
    // Format response similar to the delivery details endpoint
    const delivery = {
      uid: row.uid,
      status: row.status,
      created_at: row.created_at,
      scheduled_pickup_time: row.scheduled_pickup_time,
      actual_pickup_time: row.actual_pickup_time,
      estimated_delivery_time: row.estimated_delivery_time,
      actual_delivery_time: row.actual_delivery_time,
      package_description: row.package_description,
      package_weight: row.package_weight ? parseFloat(row.package_weight) : null,
      is_fragile: row.is_fragile,
      package_photo_url: row.package_photo_url,
      delivery_proof_url: row.delivery_proof_url,
      requires_signature: row.requires_signature,
      requires_id_verification: row.requires_id_verification,
      requires_photo_proof: row.requires_photo_proof,
      special_instructions: row.special_instructions,
      distance: parseFloat(row.distance),
      estimated_duration: parseInt(row.estimated_duration),
      priority_level: row.priority_level,
      verification_code: row.verification_code, // Include for courier
      package_type: {
        uid: row.package_type_uid,
        name: row.package_type_name,
        description: row.package_type_description,
        icon_url: row.icon_url
      },
      pickup_address: {
        street_address: row.pickup_street,
        unit_number: row.pickup_unit,
        city: row.pickup_city,
        state: row.pickup_state,
        postal_code: row.pickup_postal,
        country: row.pickup_country,
        lat: parseFloat(row.pickup_lat),
        lng: parseFloat(row.pickup_lng),
        delivery_instructions: row.pickup_instructions,
        access_code: row.pickup_access_code // Include for courier
      },
      delivery_address: {
        street_address: row.dropoff_street,
        unit_number: row.dropoff_unit,
        city: row.dropoff_city,
        state: row.dropoff_state,
        postal_code: row.dropoff_postal,
        country: row.dropoff_country,
        lat: parseFloat(row.dropoff_lat),
        lng: parseFloat(row.dropoff_lng),
        delivery_instructions: row.dropoff_instructions,
        access_code: row.dropoff_access_code // Include for courier
      },
      sender: {
        uid: row.sender_uid,
        first_name: row.sender_first_name,
        last_name: row.sender_last_name,
        profile_picture_url: row.sender_picture,
        average_rating: parseFloat(row.sender_rating)
      },
      recipient: {
        name: row.recipient_name,
        phone: row.recipient_phone,
        email: row.recipient_email
      },
      items: itemsResult.rows.map(item => ({
        uid: item.uid,
        name: item.name,
        quantity: item.quantity,
        description: item.description,
        declared_value: item.declared_value ? parseFloat(item.declared_value) : null,
        photo_url: item.photo_url
      })),
      status_history: statusResult.rows.map(status => ({
        status: status.status,
        timestamp: status.timestamp,
        notes: status.notes,
        location: status.latitude && status.longitude ? {
          lat: parseFloat(status.latitude),
          lng: parseFloat(status.longitude)
        } : null
      }))
    };
    
    // Add payment information
    if (row.payment_uid) {
      delivery.payment = {
        uid: row.payment_uid,
        status: row.payment_status,
        amount: parseFloat(row.payment_amount),
        tip_amount: parseFloat(row.tip_amount),
        breakdown: {
          base_fee: parseFloat(row.base_fee),
          distance_fee: parseFloat(row.distance_fee),
          weight_fee: parseFloat(row.weight_fee),
          priority_fee: parseFloat(row.priority_fee),
          tax: parseFloat(row.tax),
          discount: parseFloat(row.discount_amount || 0),
          total: parseFloat(row.payment_amount)
        }
      };
    }
    
    res.json({ delivery });
  } catch (error) {
    console.error('Error fetching active delivery:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.get('/api/courier/delivery-requests', authenticateToken, courierOnly, async (req, res) => {
  // Optional location override (if not provided, use courier's stored location)
  const { lat, lng, max_distance } = req.query;
  
  const client = await pool.connect();
  try {
    // Get courier profile and location
    const courierResult = await client.query(`
      SELECT cp.*, v.type AS vehicle_type, v.max_capacity_volume
      FROM courier_profiles cp
      LEFT JOIN vehicles v ON cp.uid = v.courier_id
      WHERE cp.user_id = $1
    `, [req.user.uid]);
    
    if (courierResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Courier profile not found' });
    }
    
    const courier = courierResult.rows[0];
    
    // Use provided location or courier's stored location
    const courierLocation = {
      lat: parseFloat(lat || courier.current_location_lat),
      lng: parseFloat(lng || courier.current_location_lng)
    };
    
    // If no location available, return error
    if (!courierLocation.lat || !courierLocation.lng) {
      return res.status(400).json({ success: false, error: 'No location', message: 'No location available. Please provide location or update courier location.' });
    }
    
    const maxDistanceKm = parseFloat(max_distance) || parseFloat(courier.service_area_radius) || 10;
    
    // Find nearby delivery requests
    const deliveryResult = await client.query(`
      SELECT d.*,
        pt.name as package_type_name, pt.uid as package_type_uid,
        pickup.street_address as pickup_street, pickup.city as pickup_city, 
        pickup.lat as pickup_lat, pickup.lng as pickup_lng,
        dropoff.city as dropoff_city, dropoff.lat as dropoff_lat, dropoff.lng as dropoff_lng,
        p.amount as payment_amount
      FROM deliveries d
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      JOIN package_types pt ON d.package_type_id = pt.uid
      LEFT JOIN payments p ON d.delivery_id = p.uid
      WHERE d.status = 'searching_courier'
        AND d.package_weight <= $1
        AND (d.scheduled_pickup_time IS NULL OR d.scheduled_pickup_time <= NOW() + INTERVAL '30 minutes')
    `, [courier.max_weight_capacity]);
    
    // Filter deliveries by distance (in a real app, this would be a geospatial query)
    const nearbyDeliveries = deliveryResult.rows.filter(delivery => {
      const pickupDistance = geolib.getDistance(
        { latitude: courierLocation.lat, longitude: courierLocation.lng },
        { latitude: delivery.pickup_lat, longitude: delivery.pickup_lng }
      ) / 1000; // Convert to kilometers
      
      return pickupDistance <= maxDistanceKm;
    });
    
    // Get the commission rate from system settings
    const settingsResult = await client.query(
      "SELECT value FROM system_settings WHERE key = 'courier_commission_rate'"
    );
    const commission_rate = parseFloat(settingsResult.rows[0]?.value || 0.8);
    
    // Format response
    const delivery_requests = nearbyDeliveries.map(delivery => {
      // Calculate pickup distance
      const pickupDistance = geolib.getDistance(
        { latitude: courierLocation.lat, longitude: courierLocation.lng },
        { latitude: delivery.pickup_lat, longitude: delivery.pickup_lng }
      ) / 1000 * 0.621371; // Convert to miles
      
      // Calculate delivery distance
      const deliveryDistance = parseFloat(delivery.distance);
      
      // Calculate total distance
      const totalDistance = pickupDistance + deliveryDistance;
      
      // Calculate earnings estimate
      const payment = parseFloat(delivery.payment_amount || 0);
      const estimatedEarnings = payment * commission_rate;
      
      // Calculate expiration time (15 minutes from creation or scheduled_pickup_time)
      const expires_at = delivery.scheduled_pickup_time || 
        new Date(new Date(delivery.created_at).getTime() + 15 * 60000);
      
      return {
        uid: delivery.uid,
        created_at: delivery.created_at,
        scheduled_pickup_time: delivery.scheduled_pickup_time,
        estimated_duration: parseInt(delivery.estimated_duration),
        priority_level: delivery.priority_level,
        package_type: {
          uid: delivery.package_type_uid,
          name: delivery.package_type_name,
          icon_url: null // Not including icon for brevity
        },
        pickup_address: {
          street_address: delivery.pickup_street.substring(0, 5) + '...', // Mask for privacy
          city: delivery.pickup_city,
          lat: parseFloat(delivery.pickup_lat),
          lng: parseFloat(delivery.pickup_lng)
        },
        delivery_address: {
          city: delivery.dropoff_city,
          lat: parseFloat(delivery.dropoff_lat),
          lng: parseFloat(delivery.dropoff_lng)
        },
        distance: {
          pickup_distance: parseFloat(pickupDistance.toFixed(2)),
          delivery_distance: deliveryDistance,
          total_distance: parseFloat(totalDistance.toFixed(2))
        },
        earnings: {
          base_amount: parseFloat((estimatedEarnings * 0.8).toFixed(2)), // Estimate base without tip
          estimated_total: parseFloat(estimatedEarnings.toFixed(2))
        },
        expires_at: expires_at
      };
    });
    
    res.json({ delivery_requests });
  } catch (error) {
    console.error('Error fetching delivery requests:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/courier/accept-delivery/:id', authenticateToken, courierOnly, async (req, res) => {
  const delivery_id = req.params.id;
  const { current_location } = req.body || {};
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Check if courier is available
    const courierResult = await client.query(`
      SELECT cp.* FROM courier_profiles cp
      WHERE cp.user_id = $1 AND cp.is_available = true AND cp.active_delivery_id IS NULL
    `, [req.user.uid]);
    
    if (courierResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'Not available', message: 'You are not available to accept deliveries' });
    }
    
    const courier_profile_uid = courierResult.rows[0].uid;
    
    // Check if delivery exists and is in a state to be accepted
    const deliveryResult = await client.query(`
      SELECT d.*, 
        pickup.lat as pickup_lat, pickup.lng as pickup_lng, 
        pickup.street_address as pickup_street, pickup.unit_number as pickup_unit,
        pickup.city as pickup_city, pickup.state as pickup_state, pickup.postal_code as pickup_postal,
        pickup.delivery_instructions as pickup_instructions, pickup.access_code as pickup_access_code
      FROM deliveries d
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      WHERE d.uid = $1 AND d.status = 'searching_courier' AND d.courier_id IS NULL
    `, [delivery_id]);
    
    if (deliveryResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, error: 'Already assigned', message: 'This delivery is no longer available' });
    }
    
    const delivery = deliveryResult.rows[0];
    
    // Update delivery with courier assignment
    await client.query(
      'UPDATE deliveries SET courier_id = $1, status = $2, current_status_since = NOW() WHERE uid = $3',
      [req.user.uid, 'courier_assigned', delivery_id]
    );
    
    // Update courier profile with active delivery
    await client.query(
      'UPDATE courier_profiles SET active_delivery_id = $1 WHERE uid = $2',
      [delivery_id, courier_profile_uid]
    );
    
    // Create status update
    await client.query(
      `INSERT INTO delivery_status_updates (uid, delivery_id, status, updated_by)
       VALUES ($1, $2, $3, $4)`,
      [uuidv4(), delivery_id, 'courier_assigned', req.user.uid]
    );
    
    // Update courier location if provided
    if (current_location && current_location.lat && current_location.lng) {
      await client.query(
        'UPDATE courier_profiles SET current_location_lat = $1, current_location_lng = $2, location_updated_at = NOW() WHERE uid = $3',
        [current_location.lat, current_location.lng, courier_profile_uid]
      );
      
      await client.query(
        `INSERT INTO location_updates (uid, user_id, delivery_id, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), req.user.uid, delivery_id, current_location.lat, current_location.lng]
      );
    }
    
    // Commit transaction
    await client.query('COMMIT');
    
    // Get courier information for notification
    const courierInfoResult = await client.query(
      'SELECT first_name, last_name, profile_picture_url, average_rating FROM users WHERE uid = $1',
      [req.user.uid]
    );
    
    const courierInfo = courierInfoResult.rows[0];
    
    // Get vehicle information
    const vehicleResult = await client.query(
      'SELECT type, color, make, model FROM vehicles WHERE courier_id = $1',
      [courier_profile_uid]
    );
    
    const vehicleInfo = vehicleResult.rows[0] || { type: 'unknown' };
    
    // Create notification for sender
    await createNotification({
      user_id: delivery.sender_id,
      delivery_id,
      type: 'status_update',
      title: 'Courier Assigned',
      content: `${courierInfo.first_name} ${courierInfo.last_name} has accepted your delivery request.`,
      action_url: `/deliveries/${delivery_id}`
    });
    
    // Broadcast to sender
    io.to(`user:${delivery.sender_id}`).emit('delivery_request_accepted', {
      delivery_id,
      courier: {
        uid: req.user.uid,
        first_name: courierInfo.first_name,
        last_name: courierInfo.last_name,
        profile_picture_url: courierInfo.profile_picture_url,
        average_rating: parseFloat(courierInfo.average_rating) || 5.0,
        vehicle: {
          type: vehicleInfo.type,
          color: vehicleInfo.color,
          make: vehicleInfo.make,
          model: vehicleInfo.model
        }
      },
      estimated_pickup_time: new Date(Date.now() + 15 * 60000).toISOString(), // Estimate 15 min
      estimated_delivery_time: delivery.estimated_delivery_time
    });
    
    // Calculate navigation URL to pickup
    // In a real app, this would be from a navigation/mapping service
    const pickupNavigationUrl = `https://www.google.com/maps/dir/?api=1&destination=${delivery.pickup_lat},${delivery.pickup_lng}`;
    
    res.json({
      success: true,
      delivery: {
        uid: delivery_id,
        status: 'courier_assigned',
        pickup_address: {
          street_address: delivery.pickup_street,
          unit_number: delivery.pickup_unit,
          city: delivery.pickup_city,
          state: delivery.pickup_state,
          postal_code: delivery.pickup_postal,
          lat: parseFloat(delivery.pickup_lat),
          lng: parseFloat(delivery.pickup_lng),
          delivery_instructions: delivery.pickup_instructions,
          access_code: delivery.pickup_access_code
        },
        navigation: {
          pickup_directions_url: pickupNavigationUrl
        }
      },
      message: 'Delivery accepted successfully'
    });
    
    // Join socket room for this delivery
    const courierSocket = Array.from(socketUsers.get(req.user.uid) || [])[0];
    if (courierSocket) {
      const socket = io.sockets.sockets.get(courierSocket);
      if (socket) {
        socket.join(`delivery:${delivery_id}`);
      }
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error accepting delivery:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/courier/delivery-status/:id', authenticateToken, courierOnly, async (req, res) => {
  const delivery_id = req.params.id;
  const { status, location, notes, delivery_proof } = req.body;
  
  if (!status) {
    return res.status(400).json({ success: false, error: 'Missing status', message: 'Status is required' });
  }
  
  // Validate status transitions
  const valid_statuses = [
    'en_route_to_pickup',
    'at_pickup',
    'picked_up',
    'in_transit',
    'approaching_dropoff',
    'at_dropoff',
    'delivered',
    'failed',
    'returned'
  ];
  
  if (!valid_statuses.includes(status)) {
    return res.status(400).json({ success: false, error: 'Invalid status', message: 'Invalid status value' });
  }
  
  const client = await pool.connect();
  try {
    // Check if delivery is assigned to this courier
    const deliveryResult = await client.query(`
      SELECT d.*,
        pickup.lat as pickup_lat, pickup.lng as pickup_lng,
        dropoff.lat as dropoff_lat, dropoff.lng as dropoff_lng
      FROM deliveries d
      JOIN addresses pickup ON d.pickup_address_id = pickup.uid
      JOIN addresses dropoff ON d.delivery_address_id = dropoff.uid
      WHERE d.uid = $1 AND d.courier_id = $2
    `, [delivery_id, req.user.uid]);
    
    if (deliveryResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Delivery not found or not assigned to you' });
    }
    
    const delivery = deliveryResult.rows[0];
    const current_status = delivery.status;
    
    // Validate status transition
    // This is a simplistic validation - in a real app, you'd have more complex rules
    const valid_transitions = {
      'courier_assigned': ['en_route_to_pickup'],
      'en_route_to_pickup': ['at_pickup', 'failed'],
      'approaching_pickup': ['at_pickup', 'failed'],
      'at_pickup': ['picked_up', 'failed'],
      'picked_up': ['in_transit', 'failed', 'returned'],
      'in_transit': ['approaching_dropoff', 'at_dropoff', 'failed', 'returned'],
      'approaching_dropoff': ['at_dropoff', 'failed', 'returned'],
      'at_dropoff': ['delivered', 'failed', 'returned']
    };
    
    if (valid_transitions[current_status] && !valid_transitions[current_status].includes(status)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid transition', 
        message: `Cannot transition from ${current_status} to ${status}`
      });
    }
    
    // Begin transaction
    await client.query('BEGIN');
    
    // Special handling for specific statuses
    let next_destination = null;
    
    // Handle specific status transitions
    switch (status) {
      case 'picked_up':
        // Set actual_pickup_time
        await client.query(
          'UPDATE deliveries SET actual_pickup_time = NOW() WHERE uid = $1',
          [delivery_id]
        );
        
        // Next destination is dropoff
        next_destination = {
          address: `${delivery.dropoff_address}`,
          lat: parseFloat(delivery.dropoff_lat),
          lng: parseFloat(delivery.dropoff_lng),
          directions_url: `https://www.google.com/maps/dir/?api=1&destination=${delivery.dropoff_lat},${delivery.dropoff_lng}`
        };
        break;
        
      case 'delivered':
        // Require delivery proof for delivered status if required
        if (delivery.requires_photo_proof && !delivery_proof?.photo_url) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            error: 'Proof required', 
            message: 'Photo proof is required for this delivery' 
          });
        }
        
        if (delivery.requires_signature && !delivery_proof?.signature_url) {
          await client.query('ROLLBACK');
          return res.status(400).json({ 
            success: false, 
            error: 'Proof required', 
            message: 'Signature is required for this delivery' 
          });
        }
        
        // Update delivery with proof and completion time
        await client.query(
          'UPDATE deliveries SET actual_delivery_time = NOW(), delivery_proof_url = $1 WHERE uid = $2',
          [delivery_proof?.photo_url || null, delivery_id]
        );
        
        // Update courier profile: clear active delivery and update counts
        await client.query(`
          UPDATE courier_profiles SET 
            active_delivery_id = NULL,
            total_deliveries = total_deliveries + 1,
            completed_deliveries = completed_deliveries + 1
          WHERE user_id = $1
        `, [req.user.uid]);
        
        // Update courier balance with payment amount
        const paymentResult = await client.query(
          'SELECT amount, tip_amount FROM payments WHERE delivery_id = $1',
          [delivery_id]
        );
        
        if (paymentResult.rows.length > 0) {
          // Get the commission rate from system settings
          const settingsResult = await client.query(
            "SELECT value FROM system_settings WHERE key = 'courier_commission_rate'"
          );
          const commission_rate = parseFloat(settingsResult.rows[0]?.value || 0.8);
          
          const payment = paymentResult.rows[0];
          const earningsAmount = parseFloat(payment.amount) * commission_rate;
          const tipAmount = parseFloat(payment.tip_amount);
          const totalEarnings = earningsAmount + tipAmount;
          
          await client.query(
            'UPDATE users SET account_balance = account_balance + $1 WHERE uid = $2',
            [totalEarnings, req.user.uid]
          );
        }
        
        // No next destination as delivery is complete
        break;
        
      case 'failed':
      case 'returned':
        // Update courier profile: clear active delivery and update counts
        await client.query(`
          UPDATE courier_profiles SET 
            active_delivery_id = NULL,
            total_deliveries = total_deliveries + 1,
            cancelled_deliveries = cancelled_deliveries + 1
          WHERE user_id = $1
        `, [req.user.uid]);
        
        // No next destination as delivery is complete
        break;
        
      default:
        // For en_route_to_pickup, set the next destination to pickup
        if (status === 'en_route_to_pickup') {
          next_destination = {
            address: `${delivery.pickup_address}`,
            lat: parseFloat(delivery.pickup_lat),
            lng: parseFloat(delivery.pickup_lng),
            directions_url: `https://www.google.com/maps/dir/?api=1&destination=${delivery.pickup_lat},${delivery.pickup_lng}`
          };
        }
    }
    
    // Update delivery status
    await client.query(
      'UPDATE deliveries SET status = $1, current_status_since = NOW() WHERE uid = $2',
      [status, delivery_id]
    );
    
    // Create status update record
    await client.query(
      `INSERT INTO delivery_status_updates 
       (uid, delivery_id, status, timestamp, latitude, longitude, notes, updated_by)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)`,
      [
        uuidv4(),
        delivery_id,
        status,
        location?.lat || null,
        location?.lng || null,
        notes || null,
        req.user.uid
      ]
    );
    
    // Create location update if coordinates provided
    if (location && location.lat && location.lng) {
      await client.query(
        `INSERT INTO location_updates (uid, user_id, delivery_id, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5)`,
        [uuidv4(), req.user.uid, delivery_id, location.lat, location.lng]
      );
      
      // Update courier location
      await client.query(
        'UPDATE courier_profiles SET current_location_lat = $1, current_location_lng = $2, location_updated_at = NOW() WHERE user_id = $3',
        [location.lat, location.lng, req.user.uid]
      );
    }
    
    // Create notification for sender
    const statusFormatted = status.replace(/_/g, ' ');
    await createNotification({
      user_id: delivery.sender_id,
      delivery_id,
      type: 'status_update',
      title: `Delivery Update: ${statusFormatted}`,
      content: `Your delivery has been updated to ${statusFormatted}.${notes ? ` Note: ${notes}` : ''}`,
      action_url: `/deliveries/${delivery_id}`
    });
    
    // Emit status change event
    io.to(`delivery:${delivery_id}`).emit('delivery_status_change', {
      delivery_id,
      previous_status: current_status,
      new_status: status,
      timestamp: new Date().toISOString(),
      updated_by: 'courier',
      location: location ? {
        lat: location.lat,
        lng: location.lng
      } : null,
      notes,
      estimated_delivery_time: delivery.estimated_delivery_time
    });
    
    // Commit transaction
    await client.query('COMMIT');
    
    res.json({
      success: true,
      delivery: {
        uid: delivery_id,
        status,
        current_status_since: new Date().toISOString(),
        next_destination
      },
      message: `Delivery status updated to ${status}`
    });
    
    // If delivery is complete (delivered/failed/returned), leave the socket room
    if (['delivered', 'failed', 'returned'].includes(status)) {
      const courierSocket = Array.from(socketUsers.get(req.user.uid) || [])[0];
      if (courierSocket) {
        const socket = io.sockets.sockets.get(courierSocket);
        if (socket) {
          socket.leave(`delivery:${delivery_id}`);
        }
      }
    }
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating delivery status:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Messaging routes
app.get('/api/messages/:delivery_id', async (req, res) => {
  const delivery_id = req.params.delivery_id;
  const { limit = 50, before, tracking_token } = req.query;
  
  let user_id = null;
  let isRecipient = false;
  
  // Check authorization
  if (tracking_token) {
    // Validate tracking token
    const delivery = await validateTrackingToken(tracking_token);
    if (!delivery) {
      return res.status(401).json({ success: false, error: 'Invalid token', message: 'The tracking token is invalid or expired' });
    }
    
    if (delivery.uid !== delivery_id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Token does not match delivery ID' });
    }
    
    isRecipient = true;
  } else {
    // Check JWT authentication
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Access denied', message: 'Authentication token required' });
    }
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
      user_id = decoded.uid;
    } catch (error) {
      return res.status(403).json({ success: false, error: 'Invalid token', message: 'Token is invalid or expired' });
    }
  }
  
  const client = await pool.connect();
  try {
    // If authenticated user, check if they have access to the delivery
    if (!isRecipient) {
      const deliveryAccessResult = await client.query(
        'SELECT * FROM deliveries WHERE uid = $1 AND (sender_id = $2 OR courier_id = $2)',
        [delivery_id, user_id]
      );
      
      if (deliveryAccessResult.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this delivery' });
      }
    }
    
    // Build query conditions
    const conditions = ['m.delivery_id = $1'];
    const values = [delivery_id];
    let paramCount = 2;
    
    if (before) {
      conditions.push(`m.created_at < $${paramCount++}`);
      values.push(new Date(before));
    }
    
    // Get messages
    const query = `
      SELECT m.*,
        sender.first_name AS sender_first_name, 
        sender.last_name AS sender_last_name,
        sender.user_type AS sender_user_type
      FROM messages m
      LEFT JOIN users sender ON m.sender_id = sender.uid
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.created_at DESC
      LIMIT $${paramCount}
    `;
    
    values.push(parseInt(limit));
    
    const result = await client.query(query, values);
    
    // Format messages
    let messages = result.rows.map(msg => {
      let sender_type;
      
      if (msg.sender_id === 'recipient') {
        sender_type = 'recipient';
      } else if (msg.sender_user_type === 'sender') {
        sender_type = 'sender';
      } else if (msg.sender_user_type === 'courier') {
        sender_type = 'courier';
      } else {
        sender_type = 'system';
      }
      
      // If user is authenticated, mark their messages as read
      if (user_id && msg.recipient_id === user_id && !msg.is_read) {
        client.query(
          'UPDATE messages SET is_read = true, read_at = NOW() WHERE uid = $1',
          [msg.uid]
        ).catch(err => console.error('Error marking message as read:', err));
      }
      
      return {
        uid: msg.uid,
        sender_id: msg.sender_id,
        sender_name: msg.sender_id === 'recipient'
          ? 'Recipient'
          : `${msg.sender_first_name} ${msg.sender_last_name}`,
        sender_type,
        recipient_id: msg.recipient_id,
        content: msg.content,
        attachment_url: msg.attachment_url,
        attachment_type: msg.attachment_type,
        is_read: msg.is_read,
        read_at: msg.read_at,
        created_at: msg.created_at
      };
    });
    
    // Sort messages by created_at in ascending order
    messages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    
    res.json({
      messages,
      has_more: result.rows.length >= parseInt(limit)
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.post('/api/messages/:delivery_id', upload.single('attachment'), async (req, res) => {
  const delivery_id = req.params.delivery_id;
  const { content, tracking_token, attachment_type } = req.body;
  
  if (!content) {
    return res.status(400).json({ success: false, error: 'Missing content', message: 'Message content is required' });
  }
  
  let user = null;
  
  // Check authorization
  if (tracking_token) {
    // Validate tracking token for recipients
    const delivery = await validateTrackingToken(tracking_token);
    if (!delivery) {
      return res.status(401).json({ success: false, error: 'Invalid token', message: 'The tracking token is invalid or expired' });
    }
    
    if (delivery.uid !== delivery_id) {
      return res.status(403).json({ success: false, error: 'Forbidden', message: 'Token does not match delivery ID' });
    }
  } else {
    // Check JWT authentication
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ success: false, error: 'Access denied', message: 'Authentication token required' });
    }
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');
      user = decoded;
    } catch (error) {
      return res.status(403).json({ success: false, error: 'Invalid token', message: 'Token is invalid or expired' });
    }
    
    // Check if user has access to the delivery
    const client = await pool.connect();
    try {
      const deliveryAccessResult = await client.query(
        'SELECT * FROM deliveries WHERE uid = $1 AND (sender_id = $2 OR courier_id = $2)',
        [delivery_id, user.uid]
      );
      
      if (deliveryAccessResult.rows.length === 0) {
        return res.status(403).json({ success: false, error: 'Forbidden', message: 'You do not have access to this delivery' });
      }
    } finally {
      client.release();
    }
  }
  
  // Handle file upload if present
  let attachment_url = null;
  if (req.file) {
    attachment_url = `/uploads/${req.file.fieldname}/${req.file.filename}`;
  } else if (req.body.attachment_url) {
    attachment_url = req.body.attachment_url;
  }
  
  try {
    // Create the message
    const message = await createMessage(
      {
        delivery_id,
        content,
        attachment_url,
        attachment_type: attachment_type || (req.file ? req.file.mimetype.startsWith('image/') ? 'image' : 'other' : null)
      },
      user
    );
    
    res.status(201).json({
      success: true,
      message,
      message: 'Message sent successfully'
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  }
});

app.put('/api/messages/:id/read', authenticateToken, async (req, res) => {
  const message_id = req.params.id;
  
  try {
    const result = await markMessageRead(message_id, req.user.uid);
    
    if (!result) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Message not found or you are not the recipient' });
    }
    
    res.json({
      success: true,
      message: {
        uid: message_id,
        is_read: true,
        read_at: result.read_at
      }
    });
  } catch (error) {
    console.error('Error marking message as read:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  }
});

// Notification routes
app.get('/api/notifications', authenticateToken, async (req, res) => {
  const { type, is_read, page = 1, limit = 20 } = req.query;
  
  // Calculate pagination
  const offset = (parseInt(page) - 1) * parseInt(limit);
  
  // Build query filters
  const filters = ['user_id = $1'];
  const values = [req.user.uid];
  let paramCount = 2;
  
  if (type) {
    filters.push(`type = $${paramCount++}`);
    values.push(type);
  }
  
  if (is_read !== undefined) {
    filters.push(`is_read = $${paramCount++}`);
    values.push(is_read === 'true');
  }
  
  const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  
  const client = await pool.connect();
  try {
    // Get total count for pagination
    const countQuery = `
      SELECT COUNT(*) AS total
      FROM notifications
      ${whereClause}
    `;
    
    const countResult = await client.query(countQuery, values);
    const totalItems = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(totalItems / parseInt(limit));
    
    // Get unread count
    const unreadCountResult = await client.query(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.uid]
    );
    
    const unreadCount = parseInt(unreadCountResult.rows[0].unread);
    
    // Get notifications
    const query = `
      SELECT *
      FROM notifications
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramCount++} OFFSET $${paramCount++}
    `;
    
    values.push(parseInt(limit), offset);
    
    const result = await client.query(query, values);
    
    // Format notifications
    const notifications = result.rows.map(row => ({
      uid: row.uid,
      type: row.type,
      title: row.title,
      content: row.content,
      is_read: row.is_read,
      read_at: row.read_at,
      action_url: row.action_url,
      image_url: row.image_url,
      delivery_id: row.delivery_id,
      created_at: row.created_at
    }));
    
    res.json({
      notifications,
      unread_count: unreadCount,
      pagination: {
        total_items: totalItems,
        total_pages: totalPages,
        current_page: parseInt(page),
        has_next_page: parseInt(page) < totalPages,
        has_prev_page: parseInt(page) > 1
      }
    });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/notifications/:id/read', authenticateToken, async (req, res) => {
  const notification_id = req.params.id;
  
  const client = await pool.connect();
  try {
    // Check if notification belongs to user
    const notificationResult = await client.query(
      'SELECT * FROM notifications WHERE uid = $1 AND user_id = $2',
      [notification_id, req.user.uid]
    );
    
    if (notificationResult.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Not found', message: 'Notification not found' });
    }
    
    // Update notification
    await client.query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE uid = $1',
      [notification_id]
    );
    
    res.json({
      success: true,
      notification: {
        uid: notification_id,
        is_read: true,
        read_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

app.put('/api/notifications/read-all', authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    // Get count of unread notifications
    const countResult = await client.query(
      'SELECT COUNT(*) AS count FROM notifications WHERE user_id = $1 AND is_read = false',
      [req.user.uid]
    );
    
    const count = parseInt(countResult.rows[0].count);
    
    if (count === 0) {
      return res.json({
        success: true,
        count: 0,
        message: 'No unread notifications to update'
      });
    }
    
    // Update all unread notifications
    await client.query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE user_id = $1 AND is_read = false',
      [req.user.uid]
    );
    
    res.json({
      success: true,
      count,
      message: `Marked ${count} notifications as read`
    });
  } catch (error) {
    console.error('Error marking all notifications as read:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  } finally {
    client.release();
  }
});

// Promo code routes
app.post('/api/promo-codes/validate', authenticateToken, async (req, res) => {
  const { code, order_amount = 0 } = req.body;
  
  if (!code) {
    return res.status(400).json({ success: false, error: 'Missing code', message: 'Promo code is required' });
  }
  
  try {
    const result = await validatePromoCode({
      code,
      user_id: req.user.uid,
      order_amount: parseFloat(order_amount)
    });
    
    res.json(result);
  } catch (error) {
    console.error('Error validating promo code:', error);
    res.status(500).json({ success: false, error: 'Server error', message: 'An unexpected error occurred' });
  }
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all route for SPA routing
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});