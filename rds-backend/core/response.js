function ok(res, data = {}) {
  return res.json({ success: true, ...data });
}

function fail(res, message) {
  return res.status(400).json({ success: false, error: message });
}

module.exports = { ok, fail };