const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 22)) {
  console.error(
    "Node.js 22.22 or later is required. Run nvm use before npm ci.",
  );
  process.exit(1);
}
