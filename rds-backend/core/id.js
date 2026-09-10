function id(prefix) {
  return prefix + "_" + Math.random().toString(36).substring(2, 10);
}

module.exports = { id };