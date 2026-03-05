FROM node:20-slim

# Instalar LibreOffice para conversión a PDF
RUN apt-get update && apt-get install -y \
  libreoffice \
  libreoffice-writer \
  fonts-liberation \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p outputs

EXPOSE 3000

CMD ["node", "index.js"]
