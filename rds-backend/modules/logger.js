function log(type, message) {
  const time = new Date().toISOString();
  console.log(`[${time}] [${type}] ${message}`);
}

module.exports = { log };