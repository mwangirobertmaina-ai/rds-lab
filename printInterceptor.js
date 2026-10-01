const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

function detectFrequencyAdvanced(text) {
    if (!text) return null;
    const lower = text.toLowerCase().replace(/[\s*_]+/g, " ");

    const rules = [
        { patterns: ["once daily", "od", "1x", "1 daily", "1 a day", "mara moja"], freq: 1 },
        { patterns: ["bd", "twice daily", "2x", "2 daily", "2 a day", "mara mbili"], freq: 2 },
        { patterns: ["tds", "3x", "three times", "3 daily", "3 a day", "mara tatu"], freq: 3 },
        { patterns: ["qid", "4x", "four times", "4 daily", "4 a day", "mara nne"], freq: 4 },
        { patterns: ["every 6 hours", "every 4 hours", "as needed", "prn"], freq: 5 }
    ];

    for (let rule of rules) {
        if (rule.patterns.some(p => lower.includes(p))) return rule.freq;
    }

    const dosageMatch = lower.match(/([0-9])\s*(?:by|\*|x)\s*([0-9])/);
    if (dosageMatch) {
        const frequencyPerDay = parseInt(dosageMatch[2], 10);
        if (frequencyPerDay >= 1 && frequencyPerDay <= 5) return frequencyPerDay;
    }

    const singleDigitMatch = lower.match(/(?:take|dosage|dose)?\s*([1-4])\s*(?:times|daily|per day|day)/);
    if (singleDigitMatch) return parseInt(singleDigitMatch[1], 10);

    return null;
}

function getMedicalColorStandard(freq) {
    switch (freq) {
        case 1: return { color: "#28a745", name: "Green", label: "ONCE DAILY", symbol: "☀️" };
        case 2: return { color: "#007bff", name: "Blue", label: "TWICE DAILY", symbol: "☀️ 🌙" };
        case 3: return { color: "#fd7e14", name: "Orange", label: "THREE TIMES DAILY", symbol: "🌅 ☀️ 🌙" };
        case 4: return { color: "#dc3545", name: "Red", label: "FOUR TIMES DAILY", symbol: "⏱" };
        case 5: return { color: "#6f42c1", name: "Purple", label: "FREQUENT / AS DIRECTED", symbol: "⚠️" };
        default: return { color: "#6c757d", name: "Gray", label: "STANDARD PRESCRIPTION", symbol: "💊" };
    }
}

function interceptAndProcessPrintJob(rawJobText, physicalPrinterName = "ReceiptPrinter_Thermal") {
    console.log("🖨️ [PRINT MIDDLEWARE] Intercepted raw print job from queue...");

    const freq = detectFrequencyAdvanced(rawJobText);

    if (freq === null) {
        console.warn("⚠️ [PRINT MIDDLEWARE] Frequency not detected. Passing through job unaltered.");
        sendToPhysicalPrinter(rawJobText, physicalPrinterName);
        return { success: true, mode: "passthrough", text: rawJobText };
    }

    const standard = getMedicalColorStandard(freq);
    const timestamp = new Date().toISOString();

    const transformedJob = `\n` +
        `========================================\n` +
        `  ${standard.symbol} [${standard.name.toUpperCase()} - ${standard.label}]\n` +
        `========================================\n` +
        `${rawJobText}\n` +
        `----------------------------------------\n` +
        `Processed by DoseColor™ Middleware\n` +
        `Color Name: ${standard.name.toUpperCase()}\n` +
        `Timestamp: ${timestamp}\n` +
        `========================================\n\n`;

    console.log(`✨ [PRINT MIDDLEWARE] Successfully transformed job. Assigned Color: ${standard.name.toUpperCase()}`);
    sendToPhysicalPrinter(transformedJob, physicalPrinterName);

    return {
        success: true,
        mode: "intercepted_and_color_coded",
        frequency: freq,
        colorAssigned: standard.name,
        transformedOutput: transformedJob
    };
}

function sendToPhysicalPrinter(outputContent, printerName) {
    const tempFilePath = path.join(__dirname, `../temp_print_${Date.now()}.txt`);
    try {
        fs.writeFileSync(tempFilePath, outputContent, 'utf8');
        const printCommand = process.platform === 'win32'
            ? `powershell -Command "Out-Printer -PrinterName '${printerName}' -FilePath '${tempFilePath}'"`
            : `lp -d '${printerName}' '${tempFilePath}'`;

        exec(printCommand, (error) => {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
            if (error) {
                console.error(`❌ [PRINT ERROR] Failed to send job to physical printer: ${error.message}`);
            }
        });
    } catch (err) {
        console.error(`❌ [PRINT FILE ERROR]: ${err.message}`);
    }
}

module.exports = {
    detectFrequencyAdvanced,
    interceptAndProcessPrintJob
};