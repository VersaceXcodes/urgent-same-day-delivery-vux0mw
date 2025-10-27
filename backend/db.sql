-- Create tables with appropriate constraints and data types
-- Using standard PostgreSQL data types

-- Users table
CREATE TABLE users (
    uid VARCHAR(255) PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    phone_number VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255) NOT NULL,
    profile_picture_url VARCHAR(255),
    user_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    account_balance NUMERIC(10, 2) NOT NULL DEFAULT 0,
    average_rating NUMERIC(3, 2),
    total_ratings INTEGER NOT NULL DEFAULT 0,
    referral_code VARCHAR(255),
    referred_by VARCHAR(255),
    FOREIGN KEY (referred_by) REFERENCES users(uid) ON DELETE SET NULL
);

-- Package types table
CREATE TABLE package_types (
    uid VARCHAR(255) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    max_weight NUMERIC(10, 2) NOT NULL,
    dimension_x NUMERIC(10, 2) NOT NULL,
    dimension_y NUMERIC(10, 2) NOT NULL,
    dimension_z NUMERIC(10, 2) NOT NULL,
    base_price NUMERIC(10, 2) NOT NULL,
    icon_url VARCHAR(255),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Addresses table
CREATE TABLE addresses (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255),
    label VARCHAR(255),
    street_address VARCHAR(255) NOT NULL,
    unit_number VARCHAR(255),
    city VARCHAR(255) NOT NULL,
    state VARCHAR(255) NOT NULL,
    postal_code VARCHAR(255) NOT NULL,
    country VARCHAR(255) NOT NULL DEFAULT 'US',
    lat NUMERIC(10, 6) NOT NULL,
    lng NUMERIC(10, 6) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    delivery_instructions TEXT,
    access_code VARCHAR(255),
    landmark VARCHAR(255),
    is_saved BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- Deliveries table (forward declaration for foreign key constraints)
CREATE TABLE deliveries (
    uid VARCHAR(255) PRIMARY KEY,
    sender_id VARCHAR(255) NOT NULL,
    courier_id VARCHAR(255),
    pickup_address_id VARCHAR(255) NOT NULL,
    delivery_address_id VARCHAR(255) NOT NULL,
    package_type_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    current_status_since TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    scheduled_pickup_time TIMESTAMP,
    actual_pickup_time TIMESTAMP,
    estimated_delivery_time TIMESTAMP,
    actual_delivery_time TIMESTAMP,
    package_description TEXT NOT NULL,
    package_weight NUMERIC(10, 2),
    is_fragile BOOLEAN NOT NULL DEFAULT FALSE,
    requires_signature BOOLEAN NOT NULL DEFAULT FALSE,
    requires_id_verification BOOLEAN NOT NULL DEFAULT FALSE,
    requires_photo_proof BOOLEAN NOT NULL DEFAULT TRUE,
    recipient_name VARCHAR(255) NOT NULL,
    recipient_phone VARCHAR(255),
    recipient_email VARCHAR(255),
    verification_code VARCHAR(255),
    special_instructions TEXT,
    distance NUMERIC(10, 2) NOT NULL,
    estimated_duration INTEGER NOT NULL,
    priority_level VARCHAR(50) NOT NULL DEFAULT 'standard',
    cancellation_reason TEXT,
    package_photo_url VARCHAR(255),
    delivery_proof_url VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (sender_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (courier_id) REFERENCES users(uid) ON DELETE SET NULL,
    FOREIGN KEY (pickup_address_id) REFERENCES addresses(uid) ON DELETE RESTRICT,
    FOREIGN KEY (delivery_address_id) REFERENCES addresses(uid) ON DELETE RESTRICT,
    FOREIGN KEY (package_type_id) REFERENCES package_types(uid) ON DELETE RESTRICT
);

-- Courier profiles table
CREATE TABLE courier_profiles (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    is_available BOOLEAN NOT NULL DEFAULT FALSE,
    current_location_lat NUMERIC(10, 6),
    current_location_lng NUMERIC(10, 6),
    location_updated_at TIMESTAMP,
    max_weight_capacity NUMERIC(10, 2) NOT NULL,
    background_check_status VARCHAR(50) NOT NULL DEFAULT 'not_started',
    background_check_date TIMESTAMP,
    active_delivery_id VARCHAR(255),
    total_deliveries INTEGER NOT NULL DEFAULT 0,
    completed_deliveries INTEGER NOT NULL DEFAULT 0,
    cancelled_deliveries INTEGER NOT NULL DEFAULT 0,
    id_verification_status VARCHAR(50) NOT NULL DEFAULT 'not_submitted',
    service_area_radius NUMERIC(10, 2) NOT NULL,
    service_area_center_lat NUMERIC(10, 6),
    service_area_center_lng NUMERIC(10, 6),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (active_delivery_id) REFERENCES deliveries(uid) ON DELETE SET NULL
);

-- Vehicles table
CREATE TABLE vehicles (
    uid VARCHAR(255) PRIMARY KEY,
    courier_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    make VARCHAR(255),
    model VARCHAR(255),
    year INTEGER,
    color VARCHAR(50),
    license_plate VARCHAR(50),
    insurance_verified BOOLEAN NOT NULL DEFAULT FALSE,
    max_capacity_volume NUMERIC(10, 2),
    photo_url VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (courier_id) REFERENCES courier_profiles(uid) ON DELETE CASCADE
);

-- Delivery status updates table
CREATE TABLE delivery_status_updates (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) NOT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    latitude NUMERIC(10, 6),
    longitude NUMERIC(10, 6),
    notes TEXT,
    updated_by VARCHAR(255) NOT NULL,
    estimated_time_update TIMESTAMP,
    system_generated BOOLEAN NOT NULL DEFAULT FALSE,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE,
    FOREIGN KEY (updated_by) REFERENCES users(uid) ON DELETE CASCADE
);

-- Location updates table
CREATE TABLE location_updates (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    delivery_id VARCHAR(255),
    latitude NUMERIC(10, 6) NOT NULL,
    longitude NUMERIC(10, 6) NOT NULL,
    accuracy NUMERIC(10, 2),
    heading NUMERIC(5, 2),
    speed NUMERIC(10, 2),
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    battery_level INTEGER,
    device_info VARCHAR(255),
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE
);

-- Payment methods table
CREATE TABLE payment_methods (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    payment_type VARCHAR(50) NOT NULL,
    provider VARCHAR(255),
    last_four VARCHAR(4),
    expiry_month INTEGER,
    expiry_year INTEGER,
    billing_address_id VARCHAR(255),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    token VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (billing_address_id) REFERENCES addresses(uid) ON DELETE SET NULL
);

-- Promo codes table
CREATE TABLE promo_codes (
    uid VARCHAR(255) PRIMARY KEY,
    code VARCHAR(255) UNIQUE NOT NULL,
    description TEXT NOT NULL,
    discount_type VARCHAR(50) NOT NULL,
    discount_value NUMERIC(10, 2) NOT NULL,
    minimum_order_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    maximum_discount NUMERIC(10, 2),
    start_date TIMESTAMP NOT NULL,
    end_date TIMESTAMP,
    is_one_time BOOLEAN NOT NULL DEFAULT TRUE,
    is_first_time_user BOOLEAN NOT NULL DEFAULT FALSE,
    usage_limit INTEGER,
    current_usage INTEGER NOT NULL DEFAULT 0,
    created_by VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(uid) ON DELETE CASCADE
);

-- Payments table
CREATE TABLE payments (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    sender_id VARCHAR(255) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    tip_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    payment_method_id VARCHAR(255),
    status VARCHAR(50) NOT NULL,
    transaction_id VARCHAR(255),
    base_fee NUMERIC(10, 2) NOT NULL,
    distance_fee NUMERIC(10, 2) NOT NULL,
    weight_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    priority_fee NUMERIC(10, 2) NOT NULL DEFAULT 0,
    tax NUMERIC(10, 2) NOT NULL,
    promo_code_id VARCHAR(255),
    discount_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    refund_amount NUMERIC(10, 2) NOT NULL DEFAULT 0,
    refund_reason TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE RESTRICT,
    FOREIGN KEY (sender_id) REFERENCES users(uid) ON DELETE RESTRICT,
    FOREIGN KEY (payment_method_id) REFERENCES payment_methods(uid) ON DELETE SET NULL,
    FOREIGN KEY (promo_code_id) REFERENCES promo_codes(uid) ON DELETE SET NULL
);

-- User promo usage table
CREATE TABLE user_promo_usage (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    promo_code_id VARCHAR(255) NOT NULL,
    delivery_id VARCHAR(255) NOT NULL,
    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    discount_amount NUMERIC(10, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (promo_code_id) REFERENCES promo_codes(uid) ON DELETE CASCADE,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE
);

-- Courier payouts table
CREATE TABLE courier_payouts (
    uid VARCHAR(255) PRIMARY KEY,
    courier_id VARCHAR(255) NOT NULL,
    amount NUMERIC(10, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(50) NOT NULL,
    payment_method VARCHAR(50) NOT NULL,
    transaction_id VARCHAR(255),
    bank_account_id VARCHAR(255),
    period_start TIMESTAMP NOT NULL,
    period_end TIMESTAMP NOT NULL,
    delivery_count INTEGER NOT NULL,
    fees NUMERIC(10, 2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (courier_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- Ratings table
CREATE TABLE ratings (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    rater_id VARCHAR(255) NOT NULL,
    ratee_id VARCHAR(255) NOT NULL,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment TEXT,
    timeliness_rating INTEGER CHECK (timeliness_rating BETWEEN 1 AND 5),
    communication_rating INTEGER CHECK (communication_rating BETWEEN 1 AND 5),
    handling_rating INTEGER CHECK (handling_rating BETWEEN 1 AND 5),
    issue_reported BOOLEAN NOT NULL DEFAULT FALSE,
    issue_type VARCHAR(50),
    issue_description TEXT,
    response TEXT,
    is_flagged BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE,
    FOREIGN KEY (rater_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (ratee_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- Messages table
CREATE TABLE messages (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    sender_id VARCHAR(255) NOT NULL,
    recipient_id VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    attachment_url VARCHAR(255),
    attachment_type VARCHAR(50),
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- Notifications table
CREATE TABLE notifications (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    delivery_id VARCHAR(255),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    read_at TIMESTAMP,
    action_url VARCHAR(255),
    image_url VARCHAR(255),
    sent_via_push BOOLEAN NOT NULL DEFAULT FALSE,
    sent_via_email BOOLEAN NOT NULL DEFAULT FALSE,
    sent_via_sms BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE
);

-- User preferences table
CREATE TABLE user_preferences (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL UNIQUE,
    push_new_message BOOLEAN NOT NULL DEFAULT TRUE,
    push_status_updates BOOLEAN NOT NULL DEFAULT TRUE,
    push_delivery_request BOOLEAN NOT NULL DEFAULT TRUE,
    email_delivery_completion BOOLEAN NOT NULL DEFAULT TRUE,
    email_receipts BOOLEAN NOT NULL DEFAULT TRUE,
    email_promotions BOOLEAN NOT NULL DEFAULT FALSE,
    sms_critical_updates BOOLEAN NOT NULL DEFAULT TRUE,
    language VARCHAR(10) NOT NULL DEFAULT 'en',
    timezone VARCHAR(50) NOT NULL DEFAULT 'UTC',
    distance_unit VARCHAR(20) NOT NULL DEFAULT 'miles',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- System settings table
CREATE TABLE system_settings (
    uid VARCHAR(255) PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT NOT NULL,
    description TEXT NOT NULL,
    updated_by VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (updated_by) REFERENCES users(uid) ON DELETE SET NULL
);

-- Service areas table
CREATE TABLE service_areas (
    uid VARCHAR(255) PRIMARY KEY,
    city VARCHAR(255) NOT NULL,
    state VARCHAR(255) NOT NULL,
    country VARCHAR(255) NOT NULL,
    boundaries JSONB NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    base_fee NUMERIC(10, 2) NOT NULL,
    price_per_mile NUMERIC(10, 2) NOT NULL,
    minimum_courier_density INTEGER,
    current_courier_count INTEGER NOT NULL DEFAULT 0,
    timezone VARCHAR(50) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Delivery issues table
CREATE TABLE delivery_issues (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    reported_by_id VARCHAR(255) NOT NULL,
    issue_type VARCHAR(50) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'reported',
    resolution_notes TEXT,
    resolved_by_id VARCHAR(255),
    resolved_at TIMESTAMP,
    photos_url JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE,
    FOREIGN KEY (reported_by_id) REFERENCES users(uid) ON DELETE CASCADE,
    FOREIGN KEY (resolved_by_id) REFERENCES users(uid) ON DELETE SET NULL
);

-- Bank accounts table
CREATE TABLE bank_accounts (
    uid VARCHAR(255) PRIMARY KEY,
    user_id VARCHAR(255) NOT NULL,
    account_holder_name VARCHAR(255) NOT NULL,
    account_type VARCHAR(50) NOT NULL,
    bank_name VARCHAR(255) NOT NULL,
    masked_account_number VARCHAR(255) NOT NULL,
    routing_number VARCHAR(255) NOT NULL,
    token VARCHAR(255) NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(uid) ON DELETE CASCADE
);

-- Delivery tracking links table
CREATE TABLE delivery_tracking_links (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    is_recipient_link BOOLEAN NOT NULL DEFAULT TRUE,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_accessed_at TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE
);

-- Delivery items table
CREATE TABLE delivery_items (
    uid VARCHAR(255) PRIMARY KEY,
    delivery_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    declared_value NUMERIC(10, 2),
    weight NUMERIC(10, 2),
    photo_url VARCHAR(255),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (delivery_id) REFERENCES deliveries(uid) ON DELETE CASCADE
);

-- Create indexes for commonly queried fields to improve performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_phone_number ON users(phone_number);
CREATE INDEX idx_users_user_type ON users(user_type);
CREATE INDEX idx_users_status ON users(status);

CREATE INDEX idx_courier_profiles_user_id ON courier_profiles(user_id);
CREATE INDEX idx_courier_profiles_is_available ON courier_profiles(is_available);
CREATE INDEX idx_courier_profiles_active_delivery_id ON courier_profiles(active_delivery_id);

CREATE INDEX idx_vehicles_courier_id ON vehicles(courier_id);
CREATE INDEX idx_vehicles_type ON vehicles(type);

CREATE INDEX idx_addresses_user_id ON addresses(user_id);
CREATE INDEX idx_addresses_lat_lng ON addresses(lat, lng);

CREATE INDEX idx_deliveries_sender_id ON deliveries(sender_id);
CREATE INDEX idx_deliveries_courier_id ON deliveries(courier_id);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_scheduled_pickup_time ON deliveries(scheduled_pickup_time);
CREATE INDEX idx_deliveries_created_at ON deliveries(created_at);

CREATE INDEX idx_delivery_status_updates_delivery_id ON delivery_status_updates(delivery_id);
CREATE INDEX idx_delivery_status_updates_timestamp ON delivery_status_updates(timestamp);

CREATE INDEX idx_location_updates_user_id ON location_updates(user_id);
CREATE INDEX idx_location_updates_delivery_id ON location_updates(delivery_id);
CREATE INDEX idx_location_updates_timestamp ON location_updates(timestamp);

CREATE INDEX idx_payments_delivery_id ON payments(delivery_id);
CREATE INDEX idx_payments_sender_id ON payments(sender_id);
CREATE INDEX idx_payments_status ON payments(status);

CREATE INDEX idx_payment_methods_user_id ON payment_methods(user_id);

CREATE INDEX idx_courier_payouts_courier_id ON courier_payouts(courier_id);
CREATE INDEX idx_courier_payouts_status ON courier_payouts(status);

CREATE INDEX idx_ratings_delivery_id ON ratings(delivery_id);
CREATE INDEX idx_ratings_ratee_id ON ratings(ratee_id);
CREATE INDEX idx_ratings_rater_id ON ratings(rater_id);

CREATE INDEX idx_messages_delivery_id ON messages(delivery_id);
CREATE INDEX idx_messages_recipient_id_is_read ON messages(recipient_id, is_read);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_delivery_id ON notifications(delivery_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);

CREATE INDEX idx_promo_codes_code ON promo_codes(code);
CREATE INDEX idx_promo_codes_is_active ON promo_codes(is_active);

CREATE INDEX idx_user_promo_usage_user_id ON user_promo_usage(user_id);
CREATE INDEX idx_user_promo_usage_promo_code_id ON user_promo_usage(promo_code_id);

CREATE INDEX idx_delivery_issues_delivery_id ON delivery_issues(delivery_id);
CREATE INDEX idx_delivery_issues_status ON delivery_issues(status);

CREATE INDEX idx_delivery_tracking_links_delivery_id ON delivery_tracking_links(delivery_id);
CREATE INDEX idx_delivery_tracking_links_token ON delivery_tracking_links(token);

CREATE INDEX idx_delivery_items_delivery_id ON delivery_items(delivery_id);

-- Seed data for tables

-- Seed package_types
INSERT INTO package_types (uid, name, description, max_weight, dimension_x, dimension_y, dimension_z, base_price, icon_url, is_active)
VALUES
('pkg_type_1', 'Small Envelope', 'Small envelope for documents and flat items', 1.0, 10.0, 7.0, 0.5, 5.99, 'https://example.com/icons/small_envelope.png', TRUE),
('pkg_type_2', 'Medium Box', 'Medium sized box for shoes, books, etc.', 10.0, 12.0, 10.0, 8.0, 9.99, 'https://example.com/icons/medium_box.png', TRUE),
('pkg_type_3', 'Large Box', 'Large box for bulky items', 20.0, 18.0, 16.0, 12.0, 14.99, 'https://example.com/icons/large_box.png', TRUE),
('pkg_type_4', 'Extra Large Box', 'Extra large box for bigger items', 30.0, 24.0, 20.0, 16.0, 19.99, 'https://example.com/icons/xl_box.png', TRUE),
('pkg_type_5', 'Fragile Package', 'Special handling for fragile items', 15.0, 15.0, 15.0, 15.0, 17.99, 'https://example.com/icons/fragile_package.png', TRUE);

-- Seed users (include mix of senders, couriers, and admin)
INSERT INTO users (uid, email, password_hash, phone_number, first_name, last_name, profile_picture_url, user_type, status, email_verified, phone_verified, last_login_at, account_balance, average_rating, total_ratings, referral_code) 
VALUES
-- Admin
('user_1', 'admin@flashdrop.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234000', 'Admin', 'User', 'https://picsum.photos/id/1/200', 'admin', 'active', TRUE, TRUE, NOW(), 0.00, NULL, 0, 'ADMIN001'),

-- Senders
('user_2', 'john.doe@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234001', 'John', 'Doe', 'https://picsum.photos/id/2/200', 'sender', 'active', TRUE, TRUE, NOW() - INTERVAL '2 days', 0.00, 4.5, 12, 'JOHN001'),
('user_3', 'jane.smith@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234002', 'Jane', 'Smith', 'https://picsum.photos/id/3/200', 'sender', 'active', TRUE, TRUE, NOW() - INTERVAL '3 hours', 0.00, 4.8, 8, 'JANE001'),
('user_4', 'robert.johnson@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234003', 'Robert', 'Johnson', 'https://picsum.photos/id/4/200', 'sender', 'active', TRUE, TRUE, NOW() - INTERVAL '1 day', 0.00, 4.2, 5, 'ROBT001'),
('user_5', 'susan.williams@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234004', 'Susan', 'Williams', 'https://picsum.photos/id/5/200', 'sender', 'active', TRUE, TRUE, NOW() - INTERVAL '5 hours', 0.00, 4.0, 3, 'SUSN001'),
('user_6', 'david.brown@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234005', 'David', 'Brown', 'https://picsum.photos/id/6/200', 'sender', 'active', FALSE, TRUE, NOW() - INTERVAL '7 days', 0.00, NULL, 0, 'DAVD001'),

-- Couriers
('user_7', 'michael.wilson@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234006', 'Michael', 'Wilson', 'https://picsum.photos/id/7/200', 'courier', 'active', TRUE, TRUE, NOW() - INTERVAL '2 hours', 235.50, 4.9, 45, 'MICH001'),
('user_8', 'lisa.taylor@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234007', 'Lisa', 'Taylor', 'https://picsum.photos/id/8/200', 'courier', 'active', TRUE, TRUE, NOW() - INTERVAL '5 hours', 178.25, 4.7, 32, 'LISA001'),
('user_9', 'james.anderson@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234008', 'James', 'Anderson', 'https://picsum.photos/id/9/200', 'courier', 'active', TRUE, TRUE, NOW() - INTERVAL '1 day', 312.75, 4.6, 28, 'JAMS001'),
('user_10', 'sarah.thomas@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234009', 'Sarah', 'Thomas', 'https://picsum.photos/id/10/200', 'courier', 'active', TRUE, TRUE, NOW() - INTERVAL '3 days', 89.00, 4.3, 15, 'SARA001'),
('user_11', 'ryan.jackson@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234010', 'Ryan', 'Jackson', 'https://picsum.photos/id/11/200', 'courier', 'pending', TRUE, FALSE, NULL, 0.00, NULL, 0, 'RYAN001'),
('user_12', 'emily.white@example.com', '$2a$10$uK4PXj4Z9Uo3vVFxT6bYIO4Nh2J4jDe7JJK7po/HR5SyksLfGe07O', '5551234011', 'Emily', 'White', 'https://picsum.photos/id/12/200', 'courier', 'active', TRUE, TRUE, NOW() - INTERVAL '4 hours', 145.50, 4.8, 22, 'EMIL001');

-- Seed courier_profiles
INSERT INTO courier_profiles (uid, user_id, is_available, current_location_lat, current_location_lng, location_updated_at, max_weight_capacity, background_check_status, background_check_date, active_delivery_id, total_deliveries, completed_deliveries, cancelled_deliveries, id_verification_status, service_area_radius, service_area_center_lat, service_area_center_lng)
VALUES
('c_profile_1', 'user_7', TRUE, 37.7749, -122.4194, NOW() - INTERVAL '5 minutes', 50.0, 'approved', NOW() - INTERVAL '30 days', NULL, 48, 45, 3, 'verified', 25.0, 37.7749, -122.4194),
('c_profile_2', 'user_8', TRUE, 37.7833, -122.4167, NOW() - INTERVAL '3 minutes', 30.0, 'approved', NOW() - INTERVAL '45 days', NULL, 35, 32, 3, 'verified', 15.0, 37.7833, -122.4167),
('c_profile_3', 'user_9', FALSE, 37.7899, -122.4001, NOW() - INTERVAL '2 hours', 75.0, 'approved', NOW() - INTERVAL '20 days', NULL, 30, 28, 2, 'verified', 30.0, 37.7899, -122.4001),
('c_profile_4', 'user_10', TRUE, 37.7900, -122.4100, NOW() - INTERVAL '10 minutes', 25.0, 'approved', NOW() - INTERVAL '60 days', NULL, 17, 15, 2, 'verified', 10.0, 37.7900, -122.4100),
('c_profile_5', 'user_11', FALSE, NULL, NULL, NULL, 40.0, 'pending', NULL, NULL, 0, 0, 0, 'pending', 20.0, 37.7749, -122.4194),
('c_profile_6', 'user_12', TRUE, 37.7830, -122.4200, NOW() - INTERVAL '2 minutes', 35.0, 'approved', NOW() - INTERVAL '15 days', NULL, 24, 22, 2, 'verified', 15.0, 37.7830, -122.4200);

-- Seed vehicles
INSERT INTO vehicles (uid, courier_id, type, make, model, year, color, license_plate, insurance_verified, max_capacity_volume, photo_url)
VALUES
('vehicle_1', 'c_profile_1', 'car', 'Toyota', 'Prius', 2019, 'Blue', 'ABC123', TRUE, 20.0, 'https://picsum.photos/id/111/200'),
('vehicle_2', 'c_profile_2', 'bicycle', NULL, 'Mountain Bike', 2020, 'Red', NULL, TRUE, 3.5, 'https://picsum.photos/id/146/200'),
('vehicle_3', 'c_profile_3', 'van', 'Ford', 'Transit', 2018, 'White', 'XYZ789', TRUE, 75.0, 'https://picsum.photos/id/133/200'),
('vehicle_4', 'c_profile_4', 'motorcycle', 'Honda', 'CBR', 2021, 'Black', 'DEF456', TRUE, 5.0, 'https://picsum.photos/id/156/200'),
('vehicle_5', 'c_profile_5', 'car', 'Chevrolet', 'Bolt', 2020, 'Silver', 'GHI789', FALSE, 15.0, 'https://picsum.photos/id/116/200'),
('vehicle_6', 'c_profile_6', 'bicycle', NULL, 'Electric Bike', 2022, 'Green', NULL, TRUE, 4.0, 'https://picsum.photos/id/164/200');

-- Seed addresses
INSERT INTO addresses (uid, user_id, label, street_address, unit_number, city, state, postal_code, country, lat, lng, is_default, delivery_instructions, access_code, landmark, is_saved)
VALUES 
-- John Doe's addresses
('addr_1', 'user_2', 'Home', '123 Main St', 'Apt 4B', 'San Francisco', 'CA', '94105', 'US', 37.7897, -122.3972, TRUE, 'Ring doorbell twice', NULL, 'Blue door', TRUE),
('addr_2', 'user_2', 'Work', '456 Market St', '12th Floor', 'San Francisco', 'CA', '94102', 'US', 37.7900, -122.3990, FALSE, 'Check in at reception', '1234', 'Glass building', TRUE),
-- Jane Smith's addresses
('addr_3', 'user_3', 'Home', '789 Valencia St', NULL, 'San Francisco', 'CA', '94110', 'US', 37.7598, -122.4214, TRUE, NULL, NULL, 'Corner store', TRUE),
('addr_4', 'user_3', 'Parents', '101 California St', NULL, 'San Francisco', 'CA', '94111', 'US', 37.7932, -122.3962, FALSE, 'Leave with doorman', NULL, 'High-rise building', TRUE),
-- Robert Johnson's address
('addr_5', 'user_4', 'Home', '555 Mission St', 'Unit 1000', 'San Francisco', 'CA', '94107', 'US', 37.7889, -122.3982, TRUE, NULL, NULL, NULL, TRUE),
-- Susan Williams's address
('addr_6', 'user_5', 'Home', '888 Brannan St', 'Apt 3C', 'San Francisco', 'CA', '94107', 'US', 37.7717, -122.4050, TRUE, 'Call on arrival', NULL, NULL, TRUE),
-- David Brown's address
('addr_7', 'user_6', 'Home', '1 Telegraph Hill Blvd', NULL, 'San Francisco', 'CA', '94133', 'US', 37.8023, -122.4058, TRUE, NULL, NULL, 'Near Coit Tower', TRUE),
-- One-time delivery addresses (not associated with users)
('addr_8', NULL, NULL, '1235 4th Street', 'Suite 200', 'San Francisco', 'CA', '94158', 'US', 37.7673, -122.3903, FALSE, 'Business hours only', NULL, 'UCSF Campus', FALSE),
('addr_9', NULL, NULL, '1150 16th Street', NULL, 'San Francisco', 'CA', '94107', 'US', 37.7663, -122.4005, FALSE, NULL, NULL, 'Corner building', FALSE),
('addr_10', NULL, NULL, '201 Berry Street', 'Apt 101', 'San Francisco', 'CA', '94158', 'US', 37.7757, -122.3924, FALSE, 'No parking zone, text on arrival', NULL, NULL, FALSE),
('addr_11', NULL, NULL, '601 Townsend Street', NULL, 'San Francisco', 'CA', '94103', 'US', 37.7704, -122.4030, FALSE, 'Reception desk will accept', '5678', 'Adobe building', FALSE),
('addr_12', NULL, NULL, '2 Embarcadero Center', '8th Floor', 'San Francisco', 'CA', '94111', 'US', 37.7946, -122.4002, FALSE, 'ID required for entry', NULL, 'Glass building near ferry', FALSE);

-- Seed service_areas
INSERT INTO service_areas (uid, city, state, country, boundaries, is_active, base_fee, price_per_mile, minimum_courier_density, current_courier_count, timezone)
VALUES
('area_1', 'San Francisco', 'CA', 'US', '{"type":"Polygon","coordinates":[[[-122.5107,37.7080],[-122.5107,37.8219],[-122.3580,37.8219],[-122.3580,37.7080],[-122.5107,37.7080]]]}', TRUE, 4.99, 1.25, 5, 6, 'America/Los_Angeles'),
('area_2', 'Oakland', 'CA', 'US', '{"type":"Polygon","coordinates":[[[-122.3549,37.7034],[-122.3549,37.8324],[-122.1142,37.8324],[-122.1142,37.7034],[-122.3549,37.7034]]]}', TRUE, 4.99, 1.25, 3, 4, 'America/Los_Angeles'),
('area_3', 'San Jose', 'CA', 'US', '{"type":"Polygon","coordinates":[[[-122.0238,37.2097],[-122.0238,37.4485],[-121.7061,37.4485],[-121.7061,37.2097],[-122.0238,37.2097]]]}', FALSE, 5.99, 1.50, 10, 0, 'America/Los_Angeles');

-- Seed promo_codes
INSERT INTO promo_codes (uid, code, description, discount_type, discount_value, minimum_order_amount, maximum_discount, start_date, end_date, is_one_time, is_first_time_user, usage_limit, current_usage, created_by, is_active)
VALUES
('promo_1', 'WELCOME20', 'Welcome discount 20% off', 'percentage', 20.0, 0.00, 15.00, NOW() - INTERVAL '30 days', NOW() + INTERVAL '60 days', TRUE, TRUE, 1000, 243, 'user_1', TRUE),
('promo_2', 'FLASH10', '$10 off your delivery', 'fixed_amount', 10.0, 20.00, NULL, NOW() - INTERVAL '15 days', NOW() + INTERVAL '15 days', FALSE, FALSE, 500, 126, 'user_1', TRUE),
('promo_3', 'WEEKEND25', 'Weekend special: 25% off', 'percentage', 25.0, 15.00, 20.00, NOW(), NOW() + INTERVAL '3 days', TRUE, FALSE, 200, 0, 'user_1', TRUE),
('promo_4', 'SUMMER2023', 'Summer promotion: $5 off', 'fixed_amount', 5.0, 0.00, NULL, NOW() - INTERVAL '60 days', NOW() + INTERVAL '30 days', TRUE, FALSE, 1000, 547, 'user_1', TRUE),
('promo_5', 'EXPIRED15', 'Expired promo: 15% off', 'percentage', 15.0, 0.00, 10.00, NOW() - INTERVAL '60 days', NOW() - INTERVAL '30 days', TRUE, FALSE, 300, 278, 'user_1', FALSE);

-- Seed deliveries
INSERT INTO deliveries (uid, sender_id, courier_id, pickup_address_id, delivery_address_id, package_type_id, status, current_status_since, scheduled_pickup_time, actual_pickup_time, estimated_delivery_time, actual_delivery_time, package_description, package_weight, is_fragile, requires_signature, requires_id_verification, requires_photo_proof, recipient_name, recipient_phone, recipient_email, verification_code, special_instructions, distance, estimated_duration, priority_level, package_photo_url, delivery_proof_url)
VALUES
-- Completed deliveries
('del_1', 'user_2', 'user_7', 'addr_1', 'addr_9', 'pkg_type_2', 'delivered', NOW() - INTERVAL '2 days 2 hours', NOW() - INTERVAL '2 days 6 hours', NOW() - INTERVAL '2 days 5 hours 45 minutes', NOW() - INTERVAL '2 days 3 hours', NOW() - INTERVAL '2 days 2 hours', 'Birthday gift - wrapped box', 3.5, TRUE, TRUE, FALSE, TRUE, 'Maria Johnson', '5551234567', 'maria@example.com', '7531', 'Handle with care', 2.3, 30, 'standard', 'https://picsum.photos/id/201/300', 'https://picsum.photos/id/301/300'),

('del_2', 'user_3', 'user_8', 'addr_3', 'addr_11', 'pkg_type_1', 'delivered', NOW() - INTERVAL '1 day 5 hours', NOW() - INTERVAL '1 day 8 hours', NOW() - INTERVAL '1 day 7 hours 50 minutes', NOW() - INTERVAL '1 day 6 hours', NOW() - INTERVAL '1 day 5 hours', 'Legal documents in envelope', 0.5, FALSE, TRUE, TRUE, TRUE, 'Adobe Legal Dept', '5552345678', 'legal@adobe.example.com', '9632', 'Deliver to reception', 3.1, 40, 'express', 'https://picsum.photos/id/202/300', 'https://picsum.photos/id/302/300'),

('del_3', 'user_4', 'user_9', 'addr_5', 'addr_10', 'pkg_type_3', 'delivered', NOW() - INTERVAL '4 days 1 hour', NOW() - INTERVAL '4 days 5 hours', NOW() - INTERVAL '4 days 4 hours 40 minutes', NOW() - INTERVAL '4 days 2 hours', NOW() - INTERVAL '4 days 1 hour', 'Computer monitor', 12.0, TRUE, FALSE, FALSE, TRUE, 'John Williams', '5553456789', 'john.w@example.com', '8426', 'Ring doorbell before delivery', 4.2, 55, 'standard', 'https://picsum.photos/id/203/300', 'https://picsum.photos/id/303/300'),

-- In-progress deliveries
('del_4', 'user_5', 'user_10', 'addr_6', 'addr_12', 'pkg_type_2', 'in_transit', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '5 hours', NOW() - INTERVAL '3 hours', NOW() + INTERVAL '1 hour', NULL, 'Business samples', 5.0, FALSE, TRUE, FALSE, TRUE, 'Embarcadero Investments', '5554567890', 'reception@ei.example.com', '5271', 'Ask for Mark at reception', 6.1, 70, 'express', 'https://picsum.photos/id/204/300', NULL),

('del_5', 'user_2', 'user_7', 'addr_2', 'addr_8', 'pkg_type_4', 'picked_up', NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '2 hours', NULL, 'Medical supplies', 18.5, FALSE, TRUE, TRUE, TRUE, 'UCSF Research Dept', '5555678901', 'research@ucsf.example.com', '3684', 'Temperature sensitive item', 3.8, 45, 'urgent', 'https://picsum.photos/id/205/300', NULL),

-- Pending deliveries
('del_6', 'user_3', NULL, 'addr_4', 'addr_7', 'pkg_type_2', 'searching_courier', NOW() - INTERVAL '15 minutes', NOW() + INTERVAL '2 hours', NULL, NOW() + INTERVAL '5 hours', NULL, 'Homemade cookies', 2.0, TRUE, FALSE, FALSE, TRUE, 'David Brown', '5551234005', 'david.brown@example.com', '1392', 'Please keep flat', 5.5, 65, 'standard', 'https://picsum.photos/id/206/300', NULL),

('del_7', 'user_4', NULL, 'addr_5', 'addr_6', 'pkg_type_1', 'pending', NOW() - INTERVAL '5 minutes', NOW() + INTERVAL '4 hours', NULL, NOW() + INTERVAL '7 hours', NULL, 'Concert tickets', 0.2, FALSE, TRUE, FALSE, TRUE, 'Susan Williams', '5551234004', 'susan.williams@example.com', '7384', NULL, 4.2, 50, 'standard', NULL, NULL),

-- Cancelled delivery
('del_8', 'user_5', NULL, 'addr_6', 'addr_1', 'pkg_type_5', 'cancelled', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day 2 hours', NULL, NULL, NULL, 'Antique vase', 5.0, TRUE, TRUE, FALSE, TRUE, 'John Doe', '5551234001', 'john.doe@example.com', '2846', 'Extremely fragile', 7.3, 80, 'express', 'https://picsum.photos/id/208/300', NULL);

-- Seed delivery_status_updates
INSERT INTO delivery_status_updates (uid, delivery_id, status, timestamp, latitude, longitude, notes, updated_by, estimated_time_update, system_generated)
VALUES
-- Status updates for delivery 1
('dsu_1_1', 'del_1', 'pending', NOW() - INTERVAL '2 days 6 hours 15 minutes', 37.7897, -122.3972, 'Delivery created', 'user_2', NOW() - INTERVAL '2 days 3 hours', TRUE),
('dsu_1_2', 'del_1', 'searching_courier', NOW() - INTERVAL '2 days 6 hours 10 minutes', 37.7897, -122.3972, NULL, 'user_1', NOW() - INTERVAL '2 days 3 hours', TRUE),
('dsu_1_3', 'del_1', 'courier_assigned', NOW() - INTERVAL '2 days 6 hours', 37.7897, -122.3972, 'Michael W. is your courier', 'user_1', NOW() - INTERVAL '2 days 3 hours', TRUE),
('dsu_1_4', 'del_1', 'en_route_to_pickup', NOW() - INTERVAL '2 days 5 hours 50 minutes', 37.7830, -122.4100, 'On my way to pick up', 'user_7', NOW() - INTERVAL '2 days 3 hours', FALSE),
('dsu_1_5', 'del_1', 'at_pickup', NOW() - INTERVAL '2 days 5 hours 48 minutes', 37.7897, -122.3972, 'Arrived at pickup location', 'user_7', NOW() - INTERVAL '2 days 3 hours', FALSE),
('dsu_1_6', 'del_1', 'picked_up', NOW() - INTERVAL '2 days 5 hours 45 minutes', 37.7897, -122.3972, 'Package picked up', 'user_7', NOW() - INTERVAL '2 days 3 hours', FALSE),
('dsu_1_7', 'del_1', 'in_transit', NOW() - INTERVAL '2 days 5 hours', 37.7800, -122.3985, 'On my way to deliver', 'user_7', NOW() - INTERVAL '2 days 3 hours', FALSE),
('dsu_1_8', 'del_1', 'approaching_dropoff', NOW() - INTERVAL '2 days 2 hours 15 minutes', 37.7663, -122.4000, 'Almost there', 'user_7', NOW() - INTERVAL '2 days 2 hours', FALSE),
('dsu_1_9', 'del_1', 'at_dropoff', NOW() - INTERVAL '2 days 2 hours 5 minutes', 37.7663, -122.4005, 'Arrived at delivery location', 'user_7', NOW() - INTERVAL '2 days 2 hours', FALSE),
('dsu_1_10', 'del_1', 'delivered', NOW() - INTERVAL '2 days 2 hours', 37.7663, -122.4005, 'Package delivered to recipient', 'user_7', NULL, FALSE),

-- Status updates for delivery 4 (in progress)
('dsu_4_1', 'del_4', 'pending', NOW() - INTERVAL '5 hours 15 minutes', 37.7717, -122.4050, 'Delivery created', 'user_5', NOW() + INTERVAL '1 hour', TRUE),
('dsu_4_2', 'del_4', 'searching_courier', NOW() - INTERVAL '5 hours 10 minutes', 37.7717, -122.4050, NULL, 'user_1', NOW() + INTERVAL '1 hour', TRUE),
('dsu_4_3', 'del_4', 'courier_assigned', NOW() - INTERVAL '5 hours', 37.7717, -122.4050, 'Sarah T. is your courier', 'user_1', NOW() + INTERVAL '1 hour', TRUE),
('dsu_4_4', 'del_4', 'en_route_to_pickup', NOW() - INTERVAL '4 hours 40 minutes', 37.7850, -122.4070, 'On my way to pick up', 'user_10', NOW() + INTERVAL '1 hour 15 minutes', FALSE),
('dsu_4_5', 'del_4', 'at_pickup', NOW() - INTERVAL '3 hours 10 minutes', 37.7717, -122.4050, 'Arrived at pickup location', 'user_10', NOW() + INTERVAL '1 hour', FALSE),
('dsu_4_6', 'del_4', 'picked_up', NOW() - INTERVAL '3 hours', 37.7717, -122.4050, 'Package picked up', 'user_10', NOW() + INTERVAL '1 hour', FALSE),
('dsu_4_7', 'del_4', 'in_transit', NOW() - INTERVAL '2 hours', 37.7800, -122.4020, 'On my way to deliver', 'user_10', NOW() + INTERVAL '1 hour', FALSE),

-- Status updates for delivery 6 (searching courier)
('dsu_6_1', 'del_6', 'pending', NOW() - INTERVAL '20 minutes', 37.7932, -122.3962, 'Delivery created', 'user_3', NOW() + INTERVAL '5 hours', TRUE),
('dsu_6_2', 'del_6', 'searching_courier', NOW() - INTERVAL '15 minutes', 37.7932, -122.3962, 'Looking for a courier', 'user_1', NOW() + INTERVAL '5 hours', TRUE);

-- Seed location_updates
INSERT INTO location_updates (uid, user_id, delivery_id, latitude, longitude, accuracy, heading, speed, timestamp, battery_level, device_info)
VALUES
-- Location updates for delivery 1
('loc_1_1', 'user_7', 'del_1', 37.7830, -122.4100, 10, 90, 15, NOW() - INTERVAL '2 days 5 hours 55 minutes', 85, 'iPhone 12'),
('loc_1_2', 'user_7', 'del_1', 37.7850, -122.4050, 8, 75, 12, NOW() - INTERVAL '2 days 5 hours 52 minutes', 85, 'iPhone 12'),
('loc_1_3', 'user_7', 'del_1', 37.7897, -122.3972, 5, 60, 0, NOW() - INTERVAL '2 days 5 hours 48 minutes', 84, 'iPhone 12'),
('loc_1_4', 'user_7', 'del_1', 37.7850, -122.3980, 8, 180, 18, NOW() - INTERVAL '2 days 4 hours', 82, 'iPhone 12'),
('loc_1_5', 'user_7', 'del_1', 37.7750, -122.4000, 10, 185, 20, NOW() - INTERVAL '2 days 3 hours', 80, 'iPhone 12'),
('loc_1_6', 'user_7', 'del_1', 37.7663, -122.4005, 5, 190, 0, NOW() - INTERVAL '2 days 2 hours 5 minutes', 75, 'iPhone 12'),

-- Location updates for delivery 4 (in progress)
('loc_4_1', 'user_10', 'del_4', 37.7900, -122.4100, 15, 120, 10, NOW() - INTERVAL '4 hours 50 minutes', 90, 'Samsung Galaxy S21'),
('loc_4_2', 'user_10', 'del_4', 37.7850, -122.4070, 12, 130, 12, NOW() - INTERVAL '4 hours 40 minutes', 88, 'Samsung Galaxy S21'),
('loc_4_3', 'user_10', 'del_4', 37.7800, -122.4060, 8, 135, 15, NOW() - INTERVAL '4 hours 30 minutes', 87, 'Samsung Galaxy S21'),
('loc_4_4', 'user_10', 'del_4', 37.7750, -122.4055, 10, 140, 18, NOW() - INTERVAL '4 hours', 85, 'Samsung Galaxy S21'),
('loc_4_5', 'user_10', 'del_4', 37.7717, -122.4050, 5, 145, 0, NOW() - INTERVAL '3 hours 10 minutes', 83, 'Samsung Galaxy S21'),
('loc_4_6', 'user_10', 'del_4', 37.7750, -122.4030, 8, 30, 12, NOW() - INTERVAL '2 hours 30 minutes', 80, 'Samsung Galaxy S21'),
('loc_4_7', 'user_10', 'del_4', 37.7800, -122.4020, 10, 25, 15, NOW() - INTERVAL '2 hours', 78, 'Samsung Galaxy S21'),
('loc_4_8', 'user_10', 'del_4', 37.7850, -122.4010, 12, 20, 18, NOW() - INTERVAL '1 hour 30 minutes', 75, 'Samsung Galaxy S21'),
('loc_4_9', 'user_10', 'del_4', 37.7900, -122.4005, 15, 15, 20, NOW() - INTERVAL '1 hour', 72, 'Samsung Galaxy S21'),

-- Current location updates for available couriers
('loc_c_1', 'user_7', NULL, 37.7749, -122.4194, 8, 90, 0, NOW() - INTERVAL '5 minutes', 65, 'iPhone 12'),
('loc_c_2', 'user_8', NULL, 37.7833, -122.4167, 10, 180, 0, NOW() - INTERVAL '3 minutes', 78, 'Samsung Galaxy S22'),
('loc_c_3', 'user_10', 'del_4', 37.7900, -122.4005, 12, 15, 20, NOW() - INTERVAL '1 minute', 70, 'Samsung Galaxy S21'),
('loc_c_4', 'user_12', NULL, 37.7830, -122.4200, 5, 270, 0, NOW() - INTERVAL '2 minutes', 92, 'Google Pixel 6');

-- Seed payment_methods
INSERT INTO payment_methods (uid, user_id, payment_type, provider, last_four, expiry_month, expiry_year, billing_address_id, is_default, token)
VALUES
('pm_1', 'user_2', 'credit_card', 'Visa', '4242', 12, 2025, 'addr_1', TRUE, 'tok_visa_123456'),
('pm_2', 'user_2', 'credit_card', 'Mastercard', '5678', 10, 2024, 'addr_1', FALSE, 'tok_mastercard_123456'),
('pm_3', 'user_3', 'credit_card', 'Visa', '9876', 8, 2026, 'addr_3', TRUE, 'tok_visa_234567'),
('pm_4', 'user_3', 'apple_pay', 'Apple', NULL, NULL, NULL, NULL, FALSE, 'tok_applepay_234567'),
('pm_5', 'user_4', 'credit_card', 'American Express', '3456', 5, 2025, 'addr_5', TRUE, 'tok_amex_345678'),
('pm_6', 'user_5', 'google_pay', 'Google', NULL, NULL, NULL, NULL, TRUE, 'tok_googlepay_456789'),
('pm_7', 'user_6', 'credit_card', 'Discover', '1357', 3, 2027, 'addr_7', TRUE, 'tok_discover_567890');

-- Seed bank_accounts (for couriers)
INSERT INTO bank_accounts (uid, user_id, account_holder_name, account_type, bank_name, masked_account_number, routing_number, token, is_verified, is_default)
VALUES
('ba_1', 'user_7', 'Michael Wilson', 'checking', 'Bank of America', 'XXXX1234', '123456789', 'bank_token_1234567', TRUE, TRUE),
('ba_2', 'user_8', 'Lisa Taylor', 'savings', 'Chase', 'XXXX5678', '987654321', 'bank_token_2345678', TRUE, TRUE),
('ba_3', 'user_9', 'James Anderson', 'checking', 'Wells Fargo', 'XXXX9012', '456789123', 'bank_token_3456789', TRUE, TRUE),
('ba_4', 'user_10', 'Sarah Thomas', 'checking', 'Citibank', 'XXXX3456', '789123456', 'bank_token_4567890', TRUE, TRUE),
('ba_5', 'user_11', 'Ryan Jackson', 'savings', 'Capital One', 'XXXX7890', '321654987', 'bank_token_5678901', FALSE, TRUE),
('ba_6', 'user_12', 'Emily White', 'checking', 'TD Bank', 'XXXX2468', '654987321', 'bank_token_6789012', TRUE, TRUE);

-- Seed payments
INSERT INTO payments (uid, delivery_id, sender_id, amount, tip_amount, payment_method_id, status, transaction_id, base_fee, distance_fee, weight_fee, priority_fee, tax, promo_code_id, discount_amount, refund_amount, refund_reason)
VALUES
('pay_1', 'del_1', 'user_2', 24.99, 5.00, 'pm_1', 'captured', 'txn_12345678', 9.99, 3.50, 0.00, 0.00, 1.50, 'promo_4', 5.00, 0.00, NULL),
('pay_2', 'del_2', 'user_3', 17.49, 3.00, 'pm_3', 'captured', 'txn_23456789', 5.99, 3.75, 0.00, 5.00, 0.75, NULL, 0.00, 0.00, NULL),
('pay_3', 'del_3', 'user_4', 32.98, 0.00, 'pm_5', 'captured', 'txn_34567890', 14.99, 5.25, 5.00, 0.00, 2.74, 'promo_1', 5.00, 0.00, NULL),
('pay_4', 'del_4', 'user_5', 34.99, 8.00, 'pm_6', 'authorized', 'txn_45678901', 9.99, 7.50, 2.00, 5.00, 2.50, NULL, 0.00, 0.00, NULL),
('pay_5', 'del_5', 'user_2', 45.49, 10.00, 'pm_1', 'authorized', 'txn_56789012', 19.99, 5.00, 5.00, 7.00, 3.50, 'promo_4', 5.00, 0.00, NULL),
('pay_6', 'del_6', 'user_3', 20.99, 0.00, 'pm_3', 'pending', NULL, 9.99, 6.75, 0.00, 0.00, 1.75, 'promo_2', 10.00, 0.00, NULL),
('pay_7', 'del_7', 'user_4', 12.99, 0.00, 'pm_5', 'pending', NULL, 5.99, 5.25, 0.00, 0.00, 1.75, NULL, 0.00, 0.00, NULL),
('pay_8', 'del_8', 'user_5', 37.99, 5.00, 'pm_6', 'refunded', 'txn_89012345', 17.99, 8.75, 0.00, 5.00, 3.25, 'promo_3', 7.00, 37.99, 'Delivery cancelled');

-- Seed user_promo_usage
INSERT INTO user_promo_usage (uid, user_id, promo_code_id, delivery_id, applied_at, discount_amount)
VALUES
('upu_1', 'user_2', 'promo_4', 'del_1', NOW() - INTERVAL '2 days 6 hours 15 minutes', 5.00),
('upu_2', 'user_4', 'promo_1', 'del_3', NOW() - INTERVAL '4 days 5 hours', 5.00),
('upu_3', 'user_2', 'promo_4', 'del_5', NOW() - INTERVAL '3 hours', 5.00),
('upu_4', 'user_3', 'promo_2', 'del_6', NOW() - INTERVAL '20 minutes', 10.00),
('upu_5', 'user_5', 'promo_3', 'del_8', NOW() - INTERVAL '1 day', 7.00);

-- Seed courier_payouts
INSERT INTO courier_payouts (uid, courier_id, amount, status, payment_method, transaction_id, bank_account_id, period_start, period_end, delivery_count, fees, notes)
VALUES
('payout_1', 'user_7', 185.50, 'completed', 'bank_transfer', 'pyt_12345678', 'ba_1', NOW() - INTERVAL '30 days', NOW() - INTERVAL '15 days', 12, 9.25, NULL),
('payout_2', 'user_8', 142.25, 'completed', 'bank_transfer', 'pyt_23456789', 'ba_2', NOW() - INTERVAL '30 days', NOW() - INTERVAL '15 days', 9, 7.10, NULL),
('payout_3', 'user_9', 196.75, 'completed', 'bank_transfer', 'pyt_34567890', 'ba_3', NOW() - INTERVAL '30 days', NOW() - INTERVAL '15 days', 14, 9.80, NULL),
('payout_4', 'user_10', 89.00, 'processing', 'bank_transfer', NULL, 'ba_4', NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 day', 6, 4.45, NULL),
('payout_5', 'user_12', 114.50, 'processing', 'bank_transfer', NULL, 'ba_6', NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 day', 8, 5.75, NULL);

-- Seed ratings
INSERT INTO ratings (uid, delivery_id, rater_id, ratee_id, rating, comment, timeliness_rating, communication_rating, handling_rating, issue_reported, issue_type, issue_description)
VALUES
-- Ratings for delivery 1
('rating_1', 'del_1', 'user_2', 'user_7', 5, 'Great service, arrived early!', 5, 5, 5, FALSE, NULL, NULL),
('rating_2', 'del_1', 'user_7', 'user_2', 4, 'Clear instructions, easy pickup', 4, 5, NULL, FALSE, NULL, NULL),

-- Ratings for delivery 2
('rating_3', 'del_2', 'user_3', 'user_8', 3, 'Delivery was a bit late but courier was communicative', 2, 4, 4, FALSE, NULL, NULL),
('rating_4', 'del_2', 'user_8', 'user_3', 5, 'Very friendly sender', 5, 5, NULL, FALSE, NULL, NULL),

-- Ratings for delivery 3
('rating_5', 'del_3', 'user_4', 'user_9', 5, 'Perfect delivery, handled with care', 5, 5, 5, FALSE, NULL, NULL),
('rating_6', 'del_3', 'user_9', 'user_4', 5, 'Great experience', 5, 5, NULL, FALSE, NULL, NULL),

-- Ratings with issues
('rating_7', 'del_8', 'user_5', 'user_1', 2, 'My delivery was cancelled last minute', 1, 3, NULL, TRUE, 'cancellation', 'Courier never showed up and delivery was cancelled');

-- Seed messages
INSERT INTO messages (uid, delivery_id, sender_id, recipient_id, content, attachment_url, attachment_type, is_read, read_at)
VALUES
-- Messages for delivery 1
('msg_1_1', 'del_1', 'user_2', 'user_7', 'Hi, I added special instructions for the package.', NULL, NULL, TRUE, NOW() - INTERVAL '2 days 5 hours 55 minutes'),
('msg_1_2', 'del_1', 'user_7', 'user_2', 'Thanks for the info. I will be careful with it.', NULL, NULL, TRUE, NOW() - INTERVAL '2 days 5 hours 53 minutes'),
('msg_1_3', 'del_1', 'user_7', 'user_2', 'I have arrived at the pickup location.', NULL, NULL, TRUE, NOW() - INTERVAL '2 days 5 hours 48 minutes'),
('msg_1_4', 'del_1', 'user_7', 'user_2', 'Package delivered successfully!', 'https://picsum.photos/id/301/300', 'image', TRUE, NOW() - INTERVAL '2 days 1 hour 50 minutes'),
('msg_1_5', 'del_1', 'user_2', 'user_7', 'Thank you so much!', NULL, NULL, TRUE, NOW() - INTERVAL '2 days 1 hour 45 minutes'),

-- Messages for delivery 4 (in progress)
('msg_4_1', 'del_4', 'user_10', 'user_5', 'Hello, I am on my way to pick up your package.', NULL, NULL, TRUE, NOW() - INTERVAL '4 hours 45 minutes'),
('msg_4_2', 'del_4', 'user_5', 'user_10', 'Great! The package will be ready.', NULL, NULL, TRUE, NOW() - INTERVAL '4 hours 42 minutes'),
('msg_4_3', 'del_4', 'user_10', 'user_5', 'I am at the pickup location.', 'https://picsum.photos/id/401/300', 'location', TRUE, NOW() - INTERVAL '3 hours 10 minutes'),
('msg_4_4', 'del_4', 'user_5', 'user_10', 'I will be right down.', NULL, NULL, TRUE, NOW() - INTERVAL '3 hours 8 minutes'),
('msg_4_5', 'del_4', 'user_10', 'user_5', 'Package picked up, heading to delivery now.', NULL, NULL, TRUE, NOW() - INTERVAL '2 hours 58 minutes'),
('msg_4_6', 'del_4', 'user_10', 'user_5', 'Traffic is a bit heavy, but still on schedule.', NULL, NULL, FALSE, NOW() - INTERVAL '1 hour 30 minutes'),

-- Messages for delivery 6 (searching courier)
('msg_6_1', 'del_6', 'user_3', 'user_1', 'When will a courier be assigned?', NULL, NULL, TRUE, NOW() - INTERVAL '12 minutes'),
('msg_6_2', 'del_6', 'user_1', 'user_3', 'We are looking for available couriers in your area. Should be assigned within 15 minutes.', NULL, NULL, FALSE, NOW() - INTERVAL '10 minutes');

-- Seed notifications
INSERT INTO notifications (uid, user_id, delivery_id, type, title, content, is_read, read_at, action_url, image_url, sent_via_push, sent_via_email, sent_via_sms)
VALUES
-- Notifications for sender of delivery 1
('notif_1_1', 'user_2', 'del_1', 'status_update', 'Courier Assigned', 'Michael W. has been assigned to your delivery', TRUE, NOW() - INTERVAL '2 days 5 hours 59 minutes', '/delivery/del_1', NULL, TRUE, FALSE, FALSE),
('notif_1_2', 'user_2', 'del_1', 'status_update', 'Package Picked Up', 'Your package has been picked up', TRUE, NOW() - INTERVAL '2 days 5 hours 43 minutes', '/delivery/del_1', NULL, TRUE, FALSE, FALSE),
('notif_1_3', 'user_2', 'del_1', 'status_update', 'Package Delivered', 'Your package has been delivered', TRUE, NOW() - INTERVAL '2 days 1 hour 58 minutes', '/delivery/del_1', 'https://picsum.photos/id/301/300', TRUE, TRUE, FALSE),
('notif_1_4', 'user_2', 'del_1', 'rating', 'Rate Your Experience', 'Please rate your delivery experience with Michael', TRUE, NOW() - INTERVAL '2 days 1 hour', '/rate/del_1', NULL, TRUE, TRUE, FALSE),

-- Notifications for courier of delivery 1
('notif_1_5', 'user_7', 'del_1', 'status_update', 'New Delivery Request', 'You have a new delivery request', TRUE, NOW() - INTERVAL '2 days 6 hours 1 minute', '/delivery/del_1', NULL, TRUE, FALSE, TRUE),
('notif_1_6', 'user_7', 'del_1', 'message', 'New Message', 'You have a new message from John D.', TRUE, NOW() - INTERVAL '2 days 5 hours 55 minutes', '/messages/del_1', NULL, TRUE, FALSE, FALSE),
('notif_1_7', 'user_7', 'del_1', 'rating', 'New Rating Received', 'You received a 5-star rating!', TRUE, NOW() - INTERVAL '2 days 1 hour 30 minutes', '/ratings', NULL, TRUE, FALSE, FALSE),

-- Notifications for sender of delivery 4 (in progress)
('notif_4_1', 'user_5', 'del_4', 'status_update', 'Courier Assigned', 'Sarah T. has been assigned to your delivery', TRUE, NOW() - INTERVAL '4 hours 59 minutes', '/delivery/del_4', NULL, TRUE, FALSE, FALSE),
('notif_4_2', 'user_5', 'del_4', 'status_update', 'Package Picked Up', 'Your package has been picked up', TRUE, NOW() - INTERVAL '2 hours 58 minutes', '/delivery/del_4', NULL, TRUE, FALSE, FALSE),
('notif_4_3', 'user_5', 'del_4', 'message', 'New Message', 'You have a new message from Sarah T.', FALSE, NULL, '/messages/del_4', NULL, TRUE, FALSE, FALSE),

-- Notifications for courier of delivery 4
('notif_4_4', 'user_10', 'del_4', 'status_update', 'New Delivery Request', 'You have a new delivery request', TRUE, NOW() - INTERVAL '5 hours 1 minute', '/delivery/del_4', NULL, TRUE, FALSE, TRUE),
('notif_4_5', 'user_10', 'del_4', 'message', 'New Message', 'You have a new message from Susan W.', TRUE, NOW() - INTERVAL '4 hours 42 minutes', '/messages/del_4', NULL, TRUE, FALSE, FALSE),

-- System notifications
('notif_sys_1', 'user_2', NULL, 'system', 'Account Created', 'Welcome to FlashDrop! Your account has been successfully created.', TRUE, NOW() - INTERVAL '60 days', '/profile', NULL, FALSE, TRUE, FALSE),
('notif_sys_2', 'user_3', NULL, 'promotional', 'Weekend Special', 'Use code WEEKEND25 for 25% off your deliveries this weekend!', FALSE, NULL, '/promotions', 'https://picsum.photos/id/501/300', FALSE, TRUE, FALSE),
('notif_sys_3', 'user_7', NULL, 'system', 'Weekly Earnings', 'Your weekly earnings summary is now available', FALSE, NULL, '/earnings', NULL, TRUE, TRUE, FALSE);

-- Seed user_preferences
INSERT INTO user_preferences (uid, user_id, push_new_message, push_status_updates, push_delivery_request, email_delivery_completion, email_receipts, email_promotions, sms_critical_updates, language, timezone, distance_unit)
VALUES
('pref_1', 'user_1', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_2', 'user_2', TRUE, TRUE, FALSE, TRUE, TRUE, TRUE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_3', 'user_3', TRUE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'kilometers'),
('pref_4', 'user_4', FALSE, TRUE, FALSE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_5', 'user_5', TRUE, TRUE, FALSE, TRUE, TRUE, FALSE, FALSE, 'en', 'America/Los_Angeles', 'miles'),
('pref_6', 'user_6', TRUE, TRUE, FALSE, TRUE, TRUE, TRUE, TRUE, 'es', 'America/Los_Angeles', 'kilometers'),
('pref_7', 'user_7', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_8', 'user_8', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_9', 'user_9', FALSE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'zh', 'America/Los_Angeles', 'kilometers'),
('pref_10', 'user_10', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_11', 'user_11', TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, 'en', 'America/Los_Angeles', 'miles'),
('pref_12', 'user_12', TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, 'en', 'America/Los_Angeles', 'miles');

-- Seed system_settings
INSERT INTO system_settings (uid, key, value, description, updated_by)
VALUES
('sys_1', 'base_price_multiplier', '1.0', 'Base price multiplier for all deliveries', 'user_1'),
('sys_2', 'urgent_price_multiplier', '1.5', 'Price multiplier for urgent deliveries', 'user_1'),
('sys_3', 'express_price_multiplier', '1.25', 'Price multiplier for express deliveries', 'user_1'),
('sys_4', 'max_delivery_distance', '30', 'Maximum delivery distance in miles', 'user_1'),
('sys_5', 'courier_commission_rate', '0.80', 'Percentage of delivery fee that goes to courier', 'user_1'),
('sys_6', 'tax_rate', '0.0875', 'Current tax rate for deliveries', 'user_1'),
('sys_7', 'min_courier_rating', '4.0', 'Minimum rating for couriers to remain active', 'user_1'),
('sys_8', 'max_search_time', '30', 'Maximum time in minutes to search for courier before notifying user', 'user_1'),
('sys_9', 'courier_idle_timeout', '15', 'Minutes after which an idle courier is marked unavailable', 'user_1'),
('sys_10', 'customer_support_phone', '1-800-FLASH-DROP', 'Customer support phone number', 'user_1'),
('sys_11', 'customer_support_email', 'support@flashdrop.com', 'Customer support email address', 'user_1'),
('sys_12', 'app_version', '1.0.0', 'Current app version', 'user_1');

-- Seed delivery_tracking_links
INSERT INTO delivery_tracking_links (uid, delivery_id, token, expires_at, is_recipient_link, access_count, last_accessed_at)
VALUES
('track_1', 'del_1', 'trk_a1b2c3d4e5f6g7', NOW() + INTERVAL '7 days', TRUE, 3, NOW() - INTERVAL '2 days 1 hour'),
('track_2', 'del_1', 'trk_h8i9j0k1l2m3n4', NOW() + INTERVAL '7 days', FALSE, 5, NOW() - INTERVAL '2 days 1 hour 30 minutes'),
('track_3', 'del_2', 'trk_o5p6q7r8s9t0u1', NOW() + INTERVAL '7 days', TRUE, 2, NOW() - INTERVAL '1 day 4 hours'),
('track_4', 'del_2', 'trk_v2w3x4y5z6a7b8', NOW() + INTERVAL '7 days', FALSE, 4, NOW() - INTERVAL '1 day 5 hours'),
('track_5', 'del_3', 'trk_c9d0e1f2g3h4i5', NOW() + INTERVAL '7 days', TRUE, 1, NOW() - INTERVAL '4 days'),
('track_6', 'del_3', 'trk_j6k7l8m9n0o1p2', NOW() + INTERVAL '7 days', FALSE, 6, NOW() - INTERVAL '4 days 1 hour'),
('track_7', 'del_4', 'trk_q3r4s5t6u7v8w9', NOW() + INTERVAL '7 days', TRUE, 2, NOW() - INTERVAL '2 hours'),
('track_8', 'del_4', 'trk_x0y1z2a3b4c5d6', NOW() + INTERVAL '7 days', FALSE, 8, NOW() - INTERVAL '1 hour'),
('track_9', 'del_5', 'trk_e7f8g9h0i1j2k3', NOW() + INTERVAL '7 days', TRUE, 0, NULL),
('track_10', 'del_5', 'trk_l4m5n6o7p8q9r0', NOW() + INTERVAL '7 days', FALSE, 3, NOW() - INTERVAL '30 minutes'),
('track_11', 'del_6', 'trk_s1t2u3v4w5x6y7', NOW() + INTERVAL '7 days', TRUE, 1, NOW() - INTERVAL '10 minutes'),
('track_12', 'del_6', 'trk_z8a9b0c1d2e3f4', NOW() + INTERVAL '7 days', FALSE, 2, NOW() - INTERVAL '15 minutes'),
('track_13', 'del_7', 'trk_g5h6i7j8k9l0m1', NOW() + INTERVAL '7 days', TRUE, 0, NULL),
('track_14', 'del_7', 'trk_n2o3p4q5r6s7t8', NOW() + INTERVAL '7 days', FALSE, 1, NOW() - INTERVAL '5 minutes');

-- Seed delivery_items
INSERT INTO delivery_items (uid, delivery_id, name, quantity, description, declared_value, weight, photo_url)
VALUES
('item_1', 'del_1', 'Birthday Gift Box', 1, 'Wrapped gift box with ribbon', 50.00, 3.5, 'https://picsum.photos/id/201/300'),
('item_2', 'del_2', 'Legal Document Envelope', 1, 'Sealed legal envelope', 0.00, 0.5, 'https://picsum.photos/id/202/300'),
('item_3', 'del_3', 'Computer Monitor', 1, 'Dell 27-inch monitor in box', 250.00, 12.0, 'https://picsum.photos/id/203/300'),
('item_4', 'del_4', 'Business Sample Kit', 3, 'Product samples for demonstration', 75.00, 5.0, 'https://picsum.photos/id/204/300'),
('item_5', 'del_5', 'Medical Supplies', 2, 'Sealed medical supply packages', 120.00, 18.5, 'https://picsum.photos/id/205/300'),
('item_6', 'del_6', 'Cookie Tin', 1, 'Tin container with homemade cookies', 15.00, 2.0, 'https://picsum.photos/id/206/300'),
('item_7', 'del_7', 'Concert Tickets', 2, 'Sealed envelope with tickets', 200.00, 0.2, NULL),
('item_8', 'del_8', 'Antique Vase', 1, 'Carefully packaged antique vase', 350.00, 5.0, 'https://picsum.photos/id/208/300');

-- Seed delivery_issues
INSERT INTO delivery_issues (uid, delivery_id, reported_by_id, issue_type, description, status, resolution_notes, resolved_by_id, resolved_at, photos_url)
VALUES
('issue_1', 'del_8', 'user_5', 'cancellation', 'Delivery was cancelled after waiting for courier for over an hour', 'resolved', 'Customer refunded in full and provided a promo code for next delivery', 'user_1', NOW() - INTERVAL '12 hours', NULL),
('issue_2', 'del_2', 'user_3', 'delivery_problem', 'Package was delivered to the reception but was supposed to be brought to my office', 'resolved', 'Apologized to customer and provided partial refund', 'user_1', NOW() - INTERVAL '1 day', '["https://picsum.photos/id/601/300"]'),
('issue_3', 'del_3', 'user_9', 'address_issue', 'Address was difficult to locate, building number not clearly visible', 'closed', 'Added notes to the address for future deliveries', 'user_1', NOW() - INTERVAL '3 days', '["https://picsum.photos/id/602/300", "https://picsum.photos/id/603/300"]'),
('issue_4', 'del_4', 'user_5', 'pickup_problem', 'Had to wait more than 10 minutes for sender to bring package down', 'under_review', NULL, NULL, NULL, NULL);