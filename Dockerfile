# ---- build ----
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json* ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm install --omit=dev --no-audit --no-fund -w backend && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/frontend/dist frontend/dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "backend/dist/main.js"]
