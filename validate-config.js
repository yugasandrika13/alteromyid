#!/usr/bin/env node
/**
 * ============================================
 * validate-config.js — Configuration Validator
 * ============================================
 *
 * Jalankan: node validate-config.js
 *
 * Memvalidasi bahwa konfigurasi domain sudah benar di semua file.
 */

const fs = require('fs');
const path = require('path');

const projectDir = __dirname;
let errors = 0;
let warnings = 0;
let passed = 0;

function pass(msg) {
    console.log(`  ✅ ${msg}`);
    passed++;
}

function fail(msg) {
    console.log(`  ❌ ${msg}`);
    errors++;
}

function warn(msg) {
    console.log(`  ⚠️  ${msg}`);
    warnings++;
}

// ── Test 1: site.config.js exists and is valid ─────────────

console.log('\n  🔍 Test 1: site.config.js');
console.log('  ─────────────────────────');

const siteConfigPath = path.join(projectDir, 'site.config.js');
if (fs.existsSync(siteConfigPath)) {
    pass('site.config.js exists');

    const content = fs.readFileSync(siteConfigPath, 'utf-8');

    // Try to evaluate (safe — it only defines a var)
    try {
        // Create a minimal sandbox
        const vm = require('vm');
        const sandbox = {};
        vm.createContext(sandbox);
        vm.runInContext(content, sandbox);

        if (sandbox.SITE_CONFIG) {
            pass('SITE_CONFIG object defined');

            // Check required fields
            if (sandbox.SITE_CONFIG.PRIMARY_DOMAIN) {
                pass(`PRIMARY_DOMAIN = "${sandbox.SITE_CONFIG.PRIMARY_DOMAIN}"`);
            } else {
                fail('PRIMARY_DOMAIN is missing or empty');
            }

            if (Array.isArray(sandbox.SITE_CONFIG.ALLOWED_DOMAINS) && sandbox.SITE_CONFIG.ALLOWED_DOMAINS.length > 0) {
                pass(`ALLOWED_DOMAINS = [${sandbox.SITE_CONFIG.ALLOWED_DOMAINS.join(', ')}]`);

                // Validate domain formats
                const domainRegex = /^(?!:\/\/)([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/;
                for (const d of sandbox.SITE_CONFIG.ALLOWED_DOMAINS) {
                    if (!domainRegex.test(d)) {
                        fail(`Domain "${d}" format tidak valid`);
                    }
                    if (d.startsWith('http') || d.includes('://')) {
                        fail(`Domain "${d}" mengandung protokol — hapus http(s)://`);
                    }
                    if (d.endsWith('/')) {
                        fail(`Domain "${d}" mengandung trailing slash — hapus /`);
                    }
                }
            } else {
                fail('ALLOWED_DOMAINS is missing, not an array, or empty');
            }

            if (Array.isArray(sandbox.SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES)) {
                pass(`ALLOWED_SUBDOMAIN_SUFFIXES = [${sandbox.SITE_CONFIG.ALLOWED_SUBDOMAIN_SUFFIXES.join(', ')}]`);
            } else {
                warn('ALLOWED_SUBDOMAIN_SUFFIXES is missing — subdomain matching disabled');
            }

            if (typeof sandbox.SITE_CONFIG.ALLOW_PAGES_DEV === 'boolean') {
                pass(`ALLOW_PAGES_DEV = ${sandbox.SITE_CONFIG.ALLOW_PAGES_DEV}`);
            } else {
                warn('ALLOW_PAGES_DEV not set — defaults to true');
            }

            if (typeof sandbox.SITE_CONFIG.ALLOW_LOCALHOST === 'boolean') {
                pass(`ALLOW_LOCALHOST = ${sandbox.SITE_CONFIG.ALLOW_LOCALHOST}`);
            } else {
                warn('ALLOW_LOCALHOST not set — defaults to true');
            }
        } else {
            fail('SITE_CONFIG object not found after evaluating site.config.js');
        }
    } catch (e) {
        fail(`Error evaluating site.config.js: ${e.message}`);
    }
} else {
    fail('site.config.js not found — Jalankan: node setup.js');
}

// ── Test 2: wrangler.jsonc has ALLOWED_ORIGINS ─────────────

console.log('\n  🔍 Test 2: wrangler.jsonc');
console.log('  ──────────────────────────');

const wranglerPath = path.join(projectDir, 'wrangler.jsonc');
if (fs.existsSync(wranglerPath)) {
    pass('wrangler.jsonc exists');
    const wContent = fs.readFileSync(wranglerPath, 'utf-8');

    if (wContent.includes('"ALLOWED_ORIGINS"')) {
        const match = wContent.match(/"ALLOWED_ORIGINS"\s*:\s*"([^"]*)"/);
        if (match && match[1]) {
            const origins = match[1].split(',').map(s => s.trim());
            pass(`ALLOWED_ORIGINS found with ${origins.length} origins`);
            for (const o of origins) {
                if (!o.startsWith('https://')) {
                    warn(`Origin "${o}" should start with https://`);
                }
            }
        } else {
            fail('ALLOWED_ORIGINS is empty');
        }
    } else {
        fail('ALLOWED_ORIGINS not found in wrangler.jsonc');
    }
} else {
    warn('wrangler.jsonc not found (might be using .env instead)');
}

// ── Test 3: HTML files include site.config.js ──────────────

console.log('\n  🔍 Test 3: HTML files');
console.log('  ──────────────────────');

const htmlFiles = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.html'));

for (const file of htmlFiles) {
    const filePath = path.join(projectDir, file);
    const html = fs.readFileSync(filePath, 'utf-8');

    if (html.includes('config.js')) {
        if (html.includes('site.config.js')) {
            // Check order: site.config.js should appear before config.js
            const siteIdx = html.indexOf('site.config.js');
            const configIdx = html.indexOf('config.js?');
            if (configIdx === -1 || siteIdx < configIdx) {
                pass(`${file} → site.config.js loaded before config.js`);
            } else {
                fail(`${file} → site.config.js must be loaded BEFORE config.js`);
            }
        } else {
            fail(`${file} → uses config.js but missing site.config.js`);
        }
    }
}

// ── Summary ────────────────────────────────────────────────

console.log('\n  ══════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${errors} errors, ${warnings} warnings`);

if (errors > 0) {
    console.log('  ❌ Validation FAILED — fix errors above');
    console.log('  💡 Jalankan: node setup.js (untuk auto-fix)');
    process.exit(1);
} else if (warnings > 0) {
    console.log('  ⚠️  Validation passed with WARNINGS');
    process.exit(0);
} else {
    console.log('  ✅ All checks PASSED!');
    process.exit(0);
}
console.log('');
