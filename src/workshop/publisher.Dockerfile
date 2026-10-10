FROM mcr.microsoft.com/playwright:v1.58.2-noble
WORKDIR /opt/workshop
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund playwright@1.58.2
COPY src/workshop/publisher-verifier.mjs /opt/workshop/publisher-verifier.mjs
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright HOME=/tmp
USER 10001:10001
