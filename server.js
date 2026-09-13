// ================= DRIVER LOCATION TELEMETRY ENDPOINT =================
app.post('/api/drivers/location', async (req, res) => {
    try {
        const { driverId, status, location } = req.body;
        if (!driverId) return fail(res, "Missing driverId", 400);

        if (!Array.isArray(data.drivers)) data.drivers = [];
        let driver = data.drivers.find(d => d.id === driverId);

        if (!driver) {
            driver = { id: driverId, name: `Driver ${driverId}`, status: status || 'ONLINE', location, earnings: 0 };
            data.drivers.push(driver);
        } else {
            if (status) driver.status = status;
            if (location) driver.location = location;
        }

        await saveDB();

        if (global.io) {
            global.io.emit('driverLocationUpdated', driver);
        }

        return ok(res, { driver });
    } catch (err) {
        return fail(res, "Failed to update driver location: " + err.message, 500);
    }
});