FROM node:20-alpine AS build
WORKDIR /app
# Rewrites are resolved at build time, so the backend address is a build argument.
ARG TESTPILOT_BACKEND_URL=http://backend:8001
ENV TESTPILOT_BACKEND_URL=$TESTPILOT_BACKEND_URL NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/next.config.ts ./
USER node
EXPOSE 3000
CMD ["npx", "next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
