FROM node:20-slim

# Install LibreOffice for PDF conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    libreoffice-writer \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/* \
  && apt-get clean

WORKDIR /app

# Create non-root user before copying files
RUN groupadd --gid 1001 docugen \
  && useradd --uid 1001 --gid docugen --shell /bin/sh --create-home docugen

COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=docugen:docugen . .

# Create outputs dir (fallback for non-Railway envs; Railway uses /tmp/outputs)
RUN mkdir -p outputs && chown docugen:docugen outputs

USER docugen

EXPOSE 3000

# /healthz responds immediately (before DB init) — Railway uses this path
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/healthz', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["node", "index.js"]
