FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_FILE=/data/state.enc PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
