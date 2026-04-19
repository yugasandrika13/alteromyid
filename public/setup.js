#!/usr/bin/env node
/**
 * ============================================
 * Domain Setup Script — Auto-Configure
 * ============================================
 *
 * Jalankan: node setup.js
 *
 * Script ini akan:
 * 1. Meminta domain utama Anda
 * 2. Memvalidasi format domain
 * 3. Generate/update site.config.js
 * 4. Update ALLOWED_ORIGINS di wrangler.jsonc
 * 5. Menampilkan ringkasan konfigurasi
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Helpers ────────────────────────────────────────────────

const DOMAIN_REGEX = /^(?!:\/\/)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;

function validateDomain(domain) {
    const d = domain.trim().toLowerCase();
    if (!d) return { valid: false, error: 'Domain tidak boleh kosong.' };
    if (d.startsWith('http://') || d.startsWith('https://'))
        return { valid: false, error: 'Jangan sertakan protokol (http:// atau https://). Contoh: mydomain.com' };
    if (d.endsWith('/'))
        return { valid: false, error: 'Jangan sertakan trailing slash (/). Contoh: mydomain.com' };
    if (d.includes(' '))
        return { valid: false, error: 'Domain tidak boleh mengandung spasi.' };
    if (!DOMAIN_REGEX.test(d))
        return { valid: false, error: `Format domain "${d}" tidak valid. Contoh: mydomain.com` };
    return { valid: true, domain: d };
}

function extractBaseDomain(domain) {
    // Remove www. prefix to get base domain
    return domain.replace(/^www\./, '');
}

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

// ── Templates ──────────────────────────────────────────────

function generateSiteConfig(primary, domains, suffixes, allowPagesDev, allowLocalhost) {
    return `/**
 * ============================================
 * SITE CONFIGURATION — Edit this file only!
 * ============================================
 *
 * Untuk deploy ke domain baru, ubah nilai di bawah ini.
 * Tidak perlu mengedit file lain.
 *
 * Format domain: tanpa protokol (https://), tanpa trailing slash (/)
 * Contoh: 'mydomain.com', bukan 'https://mydomain.com/'
 *
 * Jalankan "node setup.js" untuk generate file ini secara otomatis,
 * atau edit manual sesuai kebutuhan Anda.
 */
var SITE_CONFIG = {
    // ── Domain Utama (Production) ──────────────────────────
    PRIMARY_DOMAIN: '${primary}',

    // ── Daftar Domain yang Diizinkan ───────────────────────
    ALLOWED_DOMAINS: [
${domains.map(d => `        '${d}'`).join(',\n')}
    ],

    // ── Pattern Subdomain yang Diizinkan ───────────────────
    ALLOWED_SUBDOMAIN_SUFFIXES: [
${suffixes.map(s => `        '${s}'`).join(',\n')}
    ],

    // ── Cloudflare Pages Preview ───────────────────────────
    ALLOW_PAGES_DEV: ${allowPagesDev},

    // ── Local Development ──────────────────────────────────
    ALLOW_LOCALHOST: ${allowLocalhost}
};
`;
}

function generateAllowedOrigins(domains) {
    return domains.map(d => `https://${d}`).join(',');
}

// ── Main ───────────────────────────────────────────────────

async function main() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║     🚀 Domain Setup — Auto-Configure     ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        // Step 1: Ask for primary domain
        console.log('  Langkah 1: Masukkan Domain Utama');
        console.log('  ─────────────────────────────────');
        console.log('  Format: tanpa http(s)://, tanpa trailing slash');
        console.log('  Contoh: mydomain.com\n');

        let primaryDomain;
        while (true) {
            const input = await ask(rl, '  → Domain utama: ');
            const result = validateDomain(input);
            if (result.valid) {
                primaryDomain = result.domain;
                break;
            }
            console.log(`  ❌ ${result.error}\n`);
        }

        const baseDomain = extractBaseDomain(primaryDomain);

        // Step 2: Ask for additional domains
        console.log(`\n  Langkah 2: Domain Tambahan`);
        console.log('  ──────────────────────────');
        console.log(`  Domain utama: ${baseDomain} & www.${baseDomain} (otomatis)`);
        console.log('  Tambahkan domain alias jika ada (misal: domain-lain.com)');
        console.log('  Tekan Enter tanpa input jika tidak ada.\n');

        const domains = [baseDomain, `www.${baseDomain}`];
        const suffixes = [`.${baseDomain}`];

        while (true) {
            const extra = await ask(rl, '  → Domain tambahan (kosong = selesai): ');
            if (!extra.trim()) break;
            const result = validateDomain(extra);
            if (!result.valid) {
                console.log(`  ❌ ${result.error}\n`);
                continue;
            }
            const extraBase = extractBaseDomain(result.domain);
            if (!domains.includes(extraBase)) {
                domains.push(extraBase);
                domains.push(`www.${extraBase}`);
                suffixes.push(`.${extraBase}`);
                console.log(`  ✅ Ditambahkan: ${extraBase} & www.${extraBase}\n`);
            } else {
                console.log(`  ⚠️  Domain ${extraBase} sudah ada.\n`);
            }
        }

        // Step 3: Options
        console.log('\n  Langkah 3: Opsi Tambahan');
        console.log('  ────────────────────────');

        const pagesDevInput = await ask(rl, '  → Izinkan Cloudflare Pages preview (*.pages.dev)? [Y/n]: ');
        const allowPagesDev = pagesDevInput.trim().toLowerCase() !== 'n';

        const localhostInput = await ask(rl, '  → Izinkan localhost/127.0.0.1? [Y/n]: ');
        const allowLocalhost = localhostInput.trim().toLowerCase() !== 'n';

        rl.close();

        // Step 4: Generate files
        console.log('\n  Langkah 4: Generating Konfigurasi...');
        console.log('  ────────────────────────────────────');

        const projectDir = __dirname;

        // 4a. Generate site.config.js
        const siteConfigContent = generateSiteConfig(
            baseDomain, domains, suffixes, allowPagesDev, allowLocalhost
        );
        const siteConfigPath = path.join(projectDir, 'site.config.js');
        fs.writeFileSync(siteConfigPath, siteConfigContent, 'utf-8');
        console.log(`  ✅ site.config.js → ${siteConfigPath}`);

        // 4b. Update wrangler.jsonc — add/update ALLOWED_ORIGINS
        const wranglerPath = path.join(projectDir, 'wrangler.jsonc');
        if (fs.existsSync(wranglerPath)) {
            let wranglerContent = fs.readFileSync(wranglerPath, 'utf-8');
            const allowedOrigins = generateAllowedOrigins(domains);

            if (wranglerContent.includes('"ALLOWED_ORIGINS"')) {
                // Update existing
                wranglerContent = wranglerContent.replace(
                    /"ALLOWED_ORIGINS"\s*:\s*"[^"]*"/,
                    `"ALLOWED_ORIGINS": "${allowedOrigins}"`
                );
            } else {
                // Insert after "vars": {
                wranglerContent = wranglerContent.replace(
                    /("vars"\s*:\s*\{)/,
                    `$1\n    "ALLOWED_ORIGINS": "${allowedOrigins}",`
                );
            }

            fs.writeFileSync(wranglerPath, wranglerContent, 'utf-8');
            console.log(`  ✅ wrangler.jsonc → ALLOWED_ORIGINS updated`);
        } else {
            console.log(`  ⚠️  wrangler.jsonc tidak ditemukan, skip.`);
        }

        // Step 5: Summary
        console.log('\n  ╔══════════════════════════════════════════╗');
        console.log('  ║        ✅ Konfigurasi Berhasil!           ║');
        console.log('  ╚══════════════════════════════════════════╝\n');
        console.log('  Ringkasan:');
        console.log(`  • Domain utama   : ${baseDomain}`);
        console.log(`  • Domain allowed : ${domains.join(', ')}`);
        console.log(`  • Subdomain      : ${suffixes.join(', ')}`);
        console.log(`  • Pages preview  : ${allowPagesDev ? 'Ya' : 'Tidak'}`);
        console.log(`  • Localhost       : ${allowLocalhost ? 'Ya' : 'Tidak'}`);
        console.log('');
        console.log('  Langkah selanjutnya:');
        console.log('  1. Review site.config.js');
        console.log('  2. Deploy ke Cloudflare Pages: npx wrangler pages deploy .');
        console.log('  3. Jalankan node validate-config.js untuk verifikasi');
        console.log('');

    } catch (error) {
        console.error(`\n  ❌ Error: ${error.message}\n`);
        rl.close();
        process.exit(1);
    }
}

main();
