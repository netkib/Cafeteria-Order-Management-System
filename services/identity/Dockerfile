FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY jest.config.cjs ./

EXPOSE 7000

CMD ["npm", "run", "dev"]