/**
 * Import base packages
 */
const fs = require('fs');
const os = require('os');
const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const PDFDocument =  require('pdfkit');

/**
 * Import own modules
 */
const config = require('./modules/config');
const log = require('./modules/log');
const cache = require('./modules/cache');
const logo = require('./modules/logo');
const types = require('./modules/types');
const time = require('./modules/time');
const unifi = require('./modules/unifi');

/**
 * Import own middlewares
 */
const authorization = require('./middlewares/authorization');
const flashMessage = require('./middlewares/flashMessage');

/**
 * Import own utils
 */
const {updateCache} = require('./utils/cache');

/**
 * Setup Express app
 */
const app = express();

/**
 * Define global functions and variables
 */
const voucherTypes = types(config('voucher_types') || process.env.VOUCHER_TYPES || '480,0,,,;');
const webService = (process.env.SERVICE_WEB === 'true') || true;
const apiService = (process.env.SERVICE_API === 'true') || false;
const authDisabled = (process.env.DISABLE_AUTH === 'true') || false;

/**
 * Output logo
 */
logo();

/**
 * Log external config
 */
if (fs.existsSync('/data/options.json')) {
    log.info('[Options] Found at /data/options.json');
}

/**
 * Log service status
 */
log.info(`[Service][Web] ${webService ? 'Enabled!' : 'Disabled!'}`);
log.info(`[Service][Api] ${apiService ? 'Enabled!' : 'Disabled!'}`);

/**
 * Log voucher types
 */
log.info('[VoucherType] Loaded the following types:');
voucherTypes.forEach((type, key) => {
    log.info(`[VoucherType][${key}] ${time(type.expiration)}, ${type.usage === '1' ? 'single-use' : 'multi-use'}${typeof type.upload === "undefined" && typeof type.download === "undefined" && typeof type.megabytes === "undefined" ? ', no limits' : `${typeof type.upload !== "undefined" ? `, upload bandwidth limit: ${type.upload} kb/s` : ''}${typeof type.download !== "undefined" ? `, download bandwidth limit: ${type.download} kb/s` : ''}${typeof type.megabytes !== "undefined" ? `, quota limit: ${type.megabytes} mb` : ''}`}`);
});

/**
 * Log auth status
 */
log.info(`[Auth] ${authDisabled ? 'Disabled!' : 'Enabled!'}`);

/**
 * Log controller
 */
log.info(`[UniFi] Using Controller on: ${config('unifi_ip') || process.env.UNIFI_IP || '192.168.1.1'}:${config('unifi_port') || process.env.UNIFI_PORT || 443} (Site ID: ${config('unifi_site_id') || process.env.UNIFI_SITE_ID || 'default'})`);

/**
 * Trust proxy
 */
app.enable('trust proxy');

/**
 * Set template engine
 */
app.set('view engine', 'ejs');
app.set('views', `${__dirname}/template`);

/**
 * GET /_health - Health check page
 */
app.get('/_health', (req, res) => {
    res.json({
        status: 'UP',
        host: os.hostname(),
        load: process.cpuUsage(),
        mem: process.memoryUsage(),
        uptime: process.uptime()
    });
});

/**
 * Enable multer
 */
app.use(multer().none());

/**
 * Enable cookie-parser
 */
app.use(cookieParser());

/**
 * Enable flash-message
 */
app.use(flashMessage);

/**
 * Request logger
 */
app.use((req, res, next) => {
    log.info(`[Web]: ${req.originalUrl}`);
    next();
});

/**
 * Serve static public dir
 */
app.use(express.static(`${__dirname}/public`));

/**
 * Configure routers
 */
app.get('/', (req, res) => {
    if(webService) {
        res.redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
    } else {
        res.status(501).send();
    }
});

// Check if web service is enabled
if(webService) {
    app.get('/login', (req, res) => {
        // Check if authentication is disabled
        if (authDisabled) {
            res.redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            return;
        }

        const hour = new Date().getHours();
        const timeHeader = hour < 12 ? 'Good Morning' : hour < 18 ? 'Good Afternoon' : 'Good Evening';

        res.render('login', {
            baseUrl: req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : '',
            error: req.flashMessage.type === 'error',
            error_text: req.flashMessage.message || '',
            app_header: timeHeader
        });
    });
    app.post('/login', async (req, res) => {
        if (typeof req.body === "undefined") {
            res.status(400).send();
            return;
        }

        const passwordCheck = req.body.password === (process.env.SECURITY_CODE || "0000");

        if(!passwordCheck) {
            res.cookie('flashMessage', JSON.stringify({type: 'error', message: 'Password Invalid!'}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/login`);
            return;
        }

        res.cookie('authorization', req.body.password, {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
    });
    app.post('/voucher', [authorization.web], async (req, res) => {
        if (typeof req.body === "undefined") {
            res.status(400).send();
            return;
        }

        const typeCheck = (process.env.VOUCHER_TYPES || '480,0,,,;').split(';').includes(req.body['voucher-type']);

        if(!typeCheck) {
            res.cookie('flashMessage', JSON.stringify({type: 'error', message: 'Unknown Type!'}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            return;
        }

        // Create voucher code
        const voucherCode = await unifi.create(types(req.body['voucher-type'], true), parseInt(req.body['voucher-amount'])).catch((e) => {
            res.cookie('flashMessage', JSON.stringify({type: 'error', message: e}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
        });

        if(voucherCode) {
            log.info('[Cache] Requesting UniFi Vouchers...');

            const vouchers = await unifi.list().catch((e) => {
                log.error('[Cache] Error requesting vouchers!');
                log.error(e);
                res.cookie('flashMessage', JSON.stringify({type: 'error', message: e}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            });

            if(vouchers) {
                cache.vouchers = vouchers;
                cache.updated = new Date().getTime();
                log.info(`[Cache] Saved ${vouchers.length} voucher(s)`);

                res.cookie('flashMessage', JSON.stringify({type: 'info', message: parseInt(req.body['voucher-amount']) > 1 ? `${req.body['voucher-amount']} Vouchers Created!` : `Voucher Created: ${voucherCode}`}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            }
        }
    });
    app.get('/voucher/:id/remove', [authorization.web], async (req, res) => {
        // Revoke voucher code
        const response = await unifi.remove(req.params.id).catch((e) => {
            res.cookie('flashMessage', JSON.stringify({type: 'error', message: e}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
        });

        if(response) {
            log.info('[Cache] Requesting UniFi Vouchers...');

            const vouchers = await unifi.list().catch((e) => {
                log.error('[Cache] Error requesting vouchers!');
                log.error(e);
                res.cookie('flashMessage', JSON.stringify({type: 'error', message: e}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            });

            if(vouchers) {
                cache.vouchers = vouchers;
                cache.updated = new Date().getTime();
                log.info(`[Cache] Saved ${vouchers.length} voucher(s)`);

                res.cookie('flashMessage', JSON.stringify({type: 'info', message: `Voucher Removed!`}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            }
        }
    });
    app.get('/voucher/:id/print', [authorization.web], async (req, res) => {
        const voucher = cache.vouchers.find((e) => {
            return e._id === req.params.id;
        });

        if(voucher) {
            const doc = new PDFDocument({
                bufferPages: true,
                size: [226.77165354330398, 290],
                margins : {
                    top: 20,
                    bottom: 20,
                    left: 20,
                    right: 20
                }
            });

            const buffers = [];
            doc.on('data', buffers.push.bind(buffers));
            doc.on('end', () => {
                let pdfData = Buffer.concat(buffers);
                res.writeHead(200, {
                    'Content-Length': Buffer.byteLength(pdfData),
                    'Content-Type': 'application/pdf',
                    'Content-Disposition': `attachment;filename=voucher_${req.params.id}.pdf`
                }).end(pdfData);
            });

            doc.image('public/images/logo_grayscale.png', 75, 15, {fit: [75, 75], align: 'center', valign: 'center'});

            doc.moveDown(6);

            doc.font('Helvetica-Bold')
                .fontSize(20)
                .text(`WiFi Voucher Code`, {
                    align: 'center'
                });
            doc.font('Helvetica-Bold')
                .fontSize(15)
                .text(`${voucher.code.slice(0, 5)}-${voucher.code.slice(5)}`, {
                    align: 'center'
                });

            doc.moveDown(2);

            doc.font('Helvetica-Bold')
                .fontSize(12)
                .text(`Voucher Details`);

            doc.font('Helvetica-Bold')
                .fontSize(10)
                .text(`--------------------------------------------------------`);

            doc.font('Helvetica-Bold')
                .fontSize(10)
                .text(`Type: `, {
                    continued: true
                });
            doc.font('Helvetica')
                .fontSize(10)
                .text(voucher.quota === 0 ? 'Multi-use' : 'Single-use');

            doc.font('Helvetica-Bold')
                .fontSize(10)
                .text(`Duration: `, {
                    continued: true
                });
            doc.font('Helvetica')
                .fontSize(10)
                .text(time(voucher.duration));

            if(voucher.qos_usage_quota) {
                doc.font('Helvetica-Bold')
                    .fontSize(10)
                    .text(`Data Limit: `, {
                        continued: true
                    });
                doc.font('Helvetica')
                    .fontSize(10)
                    .text(`${voucher.qos_usage_quota}MB`);
            }

            if(voucher.qos_rate_max_down) {
                doc.font('Helvetica-Bold')
                    .fontSize(10)
                    .text(`Download Limit: `, {
                        continued: true
                    });
                doc.font('Helvetica')
                    .fontSize(10)
                    .text(`${voucher.qos_rate_max_down}kbps`);
            }

            if(voucher.qos_rate_max_up) {
                doc.font('Helvetica-Bold')
                    .fontSize(10)
                    .text(`Upload Limit: `, {
                        continued: true
                    });
                doc.font('Helvetica')
                    .fontSize(10)
                    .text(`${voucher.qos_rate_max_up}kbps`);
            }

            doc.end();
        } else {
            res.status(404);
            res.render('404', {
                baseUrl: req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''
            });
        }
    });
    app.get('/vouchers', [authorization.web], async (req, res) => {
        if(req.query.refresh) {
            log.info('[Cache] Requesting UniFi Vouchers...');

            const vouchers = await unifi.list().catch((e) => {
                log.error('[Cache] Error requesting vouchers!');
                log.error(e);
                res.cookie('flashMessage', JSON.stringify({type: 'error', message: e}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            });

            if(vouchers) {
                cache.vouchers = vouchers;
                cache.updated = new Date().getTime();
                log.info(`[Cache] Saved ${vouchers.length} voucher(s)`);

                res.cookie('flashMessage', JSON.stringify({type: 'info', message: 'Synced Vouchers!'}), {httpOnly: true, expires: new Date(Date.now() + 24 * 60 * 60 * 1000)}).redirect(302, `${req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''}/vouchers`);
            }

            return;
        }

        res.render('voucher', {
            baseUrl: req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : '',
            info: req.flashMessage.type === 'info',
            info_text: req.flashMessage.message || '',
            error: req.flashMessage.type === 'error',
            error_text: req.flashMessage.message || '',
            timeConvert: time,
            voucher_types: voucherTypes,
            vouchers: cache.vouchers,
            updated: cache.updated
        });
    });
}

if(apiService) {
    app.get('/api', (req, res) => {
        res.json({
            error: null,
            data: {
                message: 'OK',
                endpoints: [
                    '/api',
                    '/api/types',
                    '/api/voucher/:type'
                ]
            }
        });
    });
    app.get('/api/types', (req, res) => {
        res.json({
            error: null,
            data: {
                message: 'OK',
                types: voucherTypes
            }
        });
    });
    app.get('/api/voucher/:type', [authorization.api], async (req, res) => {
        const typeCheck = (process.env.VOUCHER_TYPES || '480,0,,,;').split(';').includes(req.params.type);

        if(!typeCheck) {
            res.json({
                error: 'Unknown Type!',
                data: {}
            });
            return;
        }

        // Create voucher code
        const voucherCode = await unifi.create(types(req.params.type, true)).catch((e) => {
            res.json({
                error: e,
                data: {}
            });
        });

        await updateCache();

        if(voucherCode) {
            res.json({
                error: null,
                data: {
                    message: 'OK',
                    voucher: voucherCode
                }
            });
        }
    });
}

/**
 * Setup default 404 message
 */
app.use((req, res) => {
    res.status(404);
    res.render('404', {
        baseUrl: req.headers['x-ingress-path'] ? req.headers['x-ingress-path'] : ''
    });
});

/**
 * Disable powered by header for security reasons
 */
app.disable('x-powered-by');

/**
 * Start listening on port
 */
app.listen(3000, '0.0.0.0', async () => {
    log.info(`[App] Running on: 0.0.0.0:3000`);
    await updateCache();

    // Run auto sync every 15 minutes
    setInterval(async () => {
        log.info('[Auto Sync] Starting Sync...');
        await updateCache();
    }, 900000);
});
