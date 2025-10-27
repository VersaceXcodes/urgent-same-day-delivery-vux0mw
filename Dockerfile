# Stage 1: Build the Vite React frontend
FROM node:18 AS frontend-build
WORKDIR /app/vitereact
# Copy package files and install dependencies with --legacy-peer-deps
COPY vitereact/package.json  ./
RUN npm install --legacy-peer-deps
RUN npm install --save-dev eslint-plugin-import eslint-plugin-react @typescript-eslint/parser @typescript-eslint/eslint-plugin
RUN npm install --save-dev eslint-import-resolver-typescript
# Copy the rest of the frontend files and build
COPY vitereact ./
# Clear any existing build artifacts to force fresh build
RUN rm -rf dist/ public/ build/
RUN npm run build

# Stage 2: Set up the Node.js backend
FROM node:18
WORKDIR /app/backend
# Copy package files and install production dependencies
COPY backend/package.json  ./
# Install dependencies
RUN npm install --production
# Copy the backend files
COPY backend ./
# Copy the frontend build output to a directory served by the backend
COPY --from=frontend-build /app/vitereact/public /app/backend/public
# Expose the port the backend will run on
EXPOSE 3000
# Set environment variables
ENV PORT=3000
ENV HOST=0.0.0.0
# Command to start the backend server - make sure it listens on all interfaces
CMD ["sh", "-c", "node initdb.js && npx tsx server.ts"]