const express = require("express");
const router = express.Router();
const { interceptAndProcessPrintJob } = require("../middleware/printInterceptor");

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

router.post("/print", (req, res) => {
    try {
        const { text, clinician, facilityName } = req.body;
        if (!text) {
            return res.status(400).json({ success: false, error: "No prescription text provided." });
        }

        const freq = detectFrequencyAdvanced(text);
        
        if (freq === null) {
            return res.json({
                success: true,
                status: "passed_through_unaltered",
                failSafeTriggered: true,
                prescription: text,
                warning: "Frequency unrecognized by auto-parser. Printed with standard formatting."
            });
        }

        const standard = getMedicalColorStandard(freq);
        const timestamp = new Date().toISOString();
        const resolvedClinician = clinician && clinician.trim() ? clinician.trim() : "Attending Clinician";
        const resolvedFacility = facilityName && facilityName.trim() ? facilityName.trim() : "General Health Facility";

        const formattedHtmlBlock = `
            <div style="border: 3px solid ${standard.color}; padding: 15px; border-radius: 8px; font-family: Arial, sans-serif; margin-bottom: 10px; background: #fff; color: #000;">
                <div style="font-size: 11px; font-weight: bold; text-transform: uppercase; color: #555; margin-bottom: 3px;">
                    🏥 ${resolvedFacility}
                </div>
                <div style="font-size: 14px; font-weight: bold; color: ${standard.color}; margin-bottom: 5px;">
                    ${standard.symbol} [${standard.name.toUpperCase()} – ${standard.label}]
                </div>
                <div style="font-size: 16px; font-weight: bold;">${text}</div>
                <div style="font-size: 10px; color: #555; margin-top: 8px; border-top: 1px solid #ddd; padding-top: 5px; display: flex; justify-content: space-between;">
                    <span>Clinician: ${resolvedClinician}</span>
                    <span>${timestamp}</span>
                </div>
            </div>
        `;

        res.json({
            success: true,
            status: "processed_and_color_coded",
            facility: resolvedFacility,
            frequency: freq,
            label: standard.label,
            colorName: standard.name,
            colorCode: standard.color,
            symbol: standard.symbol,
            prescription: text,
            formattedBlock: formattedHtmlBlock
        });

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post("/middleware/intercept-print", (req, res) => {
    try {
        const { rawText, targetPrinter } = req.body;
        if (!rawText) {
            return res.status(400).json({ success: false, error: "No raw print text received." });
        }

        const result = interceptAndProcessPrintJob(rawText, targetPrinter || "Thermal_Receipt_Printer");
        res.json(result);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;