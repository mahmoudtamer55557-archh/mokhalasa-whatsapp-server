FROM node:20-slim

# Install system dependencies if needed
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package manifests and install
COPY package*.json ./
RUN npm install --omit=dev

# Copy application source
COPY . .

# Expose default port (7860 for HuggingFace Spaces, or 3001/PORT)
EXPOSE 7860
EXPOSE 3001

ENV PORT=7860

CMD ["npm", "start"]
