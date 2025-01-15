# Use Node.js as the base image
FROM node:16

# Install mysql-client, ssh, sshpass, and cron
RUN apt-get update && apt-get install -y mysql-client openssh-client sshpass cron

# Set the working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the application port
EXPOSE 3000

# Start the application and cron service
CMD (cron && npm start)