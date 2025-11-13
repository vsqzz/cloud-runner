FROM node:20-alpine

# Install Java for Minecraft servers
RUN apk add --no-cache openjdk17-jre bash

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Create workspace directories
RUN mkdir -p /app/workspace/bots /app/workspace/minecraft-servers

# Set environment
ENV NODE_ENV=production
ENV WORKSPACE_ROOT=/app/workspace

# Start the runner
CMD ["npm", "start"]
