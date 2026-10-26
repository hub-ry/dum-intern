FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run typecheck \
  && useradd --create-home --uid 10001 intern \
  && chown -R intern:intern /app

USER intern

ENV HOST=0.0.0.0
ENV PORT=8074
EXPOSE 8074

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8074)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
