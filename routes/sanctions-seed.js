'use strict';
// ============================================================================
// routes/sanctions-seed.js — STAGE 194 (additive)
// A STARTER sanctions screening list so screening is ACTIVE out of the box.
// These are well-known, publicly designated entities (UN Consolidated / OFAC SDN
// summary level). It is NOT the full official list.
//
// >>> BEFORE REAL GO-LIVE: replace this with the full, current official lists
//     (UN Consolidated, OFAC SDN, Kenya POCAMLA/TFS) by POSTing them to
//     /api/admin/compliance/sanctions  { entries:[{name,aliases,ref}], source, listDate }
// ============================================================================
const STARTER = [
    { name: 'Al-Qaida', aliases: ['Al Qaeda', 'Al-Qaeda', 'The Base', 'Al Qaida'], ref: 'UN-QDe.004' },
    { name: 'Islamic State in Iraq and the Levant', aliases: ['ISIL', 'ISIS', 'Daesh', 'Islamic State', 'IS'], ref: 'UN-QDe.115' },
    { name: 'Al-Shabaab', aliases: ['Harakat Shabaab al-Mujahidin', 'Al-Shabab', 'Shabaab'], ref: 'UN-SOe.001' },
    { name: 'Boko Haram', aliases: ["Jama'atu Ahlis Sunna Lidda'awati wal-Jihad", 'Islamic State West Africa Province', 'ISWAP'], ref: 'UN-QDe.138' },
    { name: 'Taliban', aliases: ['Islamic Emirate of Afghanistan'], ref: 'UN-TAe' },
    { name: 'Hizballah', aliases: ['Hezbollah', 'Hizbollah', 'Party of God'], ref: 'OFAC-SDGT' },
    { name: 'Al-Nusrah Front', aliases: ['Jabhat al-Nusra', "Hay'at Tahrir al-Sham", 'HTS', 'Al-Nusra'], ref: 'UN-QDe.137' },
    { name: 'Lashkar-e-Tayyiba', aliases: ['LeT', 'Army of the Pure', 'Jamaat-ud-Dawa'], ref: 'UN-QDe.118' },
    { name: 'Jaish-e-Mohammed', aliases: ['JeM', 'Army of Mohammed'], ref: 'UN-QDe.019' },
    { name: "Islamic Revolutionary Guard Corps", aliases: ['IRGC', 'Pasdaran', 'IRGC-Quds Force'], ref: 'OFAC-SDGT' },
    { name: 'Kataib Hizballah', aliases: ['Hizballah Brigades', 'Khataib Hezbollah'], ref: 'OFAC-SDGT' },
    { name: 'Al-Qaida in the Arabian Peninsula', aliases: ['AQAP', 'Ansar al-Sharia'], ref: 'UN-QDe.129' },
    { name: 'Al-Qaida in the Islamic Maghreb', aliases: ['AQIM'], ref: 'UN-QDe.014' },
    { name: 'Haqqani Network', aliases: ['HQN'], ref: 'UN-TAe.012' },
    { name: 'Tehrik-e Taliban Pakistan', aliases: ['TTP', 'Pakistani Taliban'], ref: 'UN-QDe.132' },
    { name: 'Abu Sayyaf Group', aliases: ['ASG', 'Al Harakat al Islamiyya'], ref: 'UN-QDe.001' },
    { name: 'Ansaru', aliases: ['Jamaatu Ansarul Muslimina Fi Biladis-Sudan'], ref: 'UN-QDe.142' },
    { name: 'Islamic State in the Greater Sahara', aliases: ['ISGS', 'ISIS-GS'], ref: 'UN-QDe.163' },
    { name: 'Islamic State West Africa Province', aliases: ['ISWAP', 'ISIS-WA'], ref: 'UN-QDe.162' },
    { name: 'Al-Itihaad al-Islamiya', aliases: ['AIAI'], ref: 'UN-SOe' }
];

// register(compliance): if no list is loaded yet, load the starter so screening is active.
module.exports = function (compliance) {
    try {
        if (!compliance || typeof compliance.loadSanctions !== 'function') return { ok: false, reason: 'no compliance engine' };
        const s = compliance.state && compliance.state.sanctions;
        if (s && Array.isArray(s.entries) && s.entries.length > 0) return { ok: true, skipped: 'a list is already loaded' };
        const r = compliance.loadSanctions(STARTER, { source: 'RDS STARTER list — replace with official UN/OFAC/Kenya TFS', listDate: 'starter' }, 'SYSTEM/STAGE194');
        return { ok: true, loaded: r.entries };
    } catch (e) { return { ok: false, error: e.message }; }
};
module.exports.STARTER = STARTER;