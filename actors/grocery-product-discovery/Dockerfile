FROM apify/actor-node:22

# Install production dependencies first for better layer caching.
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional --no-audit --no-fund \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" && node --version

COPY --chown=myuser . ./

# tsx runs the TypeScript sources directly (no separate build step).
CMD ["npx", "tsx", "src/main.ts"]
