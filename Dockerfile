FROM node:20-alpine
WORKDIR /app
COPY package.json /app/package.json
RUN npm install --omit=dev
COPY server.js /app/server.js
EXPOSE 3001
CMD ["node", "server.js"]
