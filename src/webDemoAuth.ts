import crypto from 'crypto';
import { config } from './config';

const CLOCK_SKEW_TOLERANCE_SECONDS = 60; // ±60 seconds for clock drift

export interface TokenValidationResult {
    valid: boolean;
    userId?: string;
    error?: string;
}

/**
 * Validate a web demo token.
 * Token format: base64url(timestamp.userId.hmac)
 * 
 * Security measures:
 * - HMAC-SHA256 signature verification using timingSafeEqual
 * - Token expiry check (default 5 minutes)
 * - Future timestamp rejection with clock skew tolerance
 * - base64url encoding to avoid URL encoding issues
 */
export function validateWebDemoToken(token: string): TokenValidationResult {
    if (!config.webDemoSharedSecret) {
        console.error('❌ WEB_DEMO_SHARED_SECRET not configured');
        return { valid: false, error: 'Server configuration error' };
    }

    if (!token) {
        return { valid: false, error: 'Token required' };
    }

    try {
        // Decode base64url
        const decoded = Buffer.from(token, 'base64url').toString('utf-8');
        const parts = decoded.split('.');

        if (parts.length !== 3) {
            return { valid: false, error: 'Invalid token format' };
        }

        const [timestampStr, userId, providedHmac] = parts;
        const timestamp = parseInt(timestampStr, 10);

        if (isNaN(timestamp)) {
            return { valid: false, error: 'Invalid timestamp' };
        }

        const now = Math.floor(Date.now() / 1000);

        // Reject future timestamps (with tolerance for clock skew)
        if (timestamp > now + CLOCK_SKEW_TOLERANCE_SECONDS) {
            console.warn(`⚠️ Web demo token from future: timestamp=${timestamp}, now=${now}`);
            return { valid: false, error: 'Token not yet valid' };
        }

        // Check expiry (with tolerance for clock skew)
        const effectiveExpiry = config.webDemoTokenExpirySeconds + CLOCK_SKEW_TOLERANCE_SECONDS;
        if (now - timestamp > effectiveExpiry) {
            console.warn(`⚠️ Web demo token expired: age=${now - timestamp}s, limit=${effectiveExpiry}s`);
            return { valid: false, error: 'Token expired' };
        }

        // Compute expected HMAC
        const expectedHmac = crypto
            .createHmac('sha256', config.webDemoSharedSecret)
            .update(`${timestampStr}.${userId}`)
            .digest('hex');

        // Use timingSafeEqual to prevent timing attacks
        const providedBuffer = Buffer.from(providedHmac, 'utf-8');
        const expectedBuffer = Buffer.from(expectedHmac, 'utf-8');

        if (providedBuffer.length !== expectedBuffer.length) {
            console.warn('⚠️ Web demo token HMAC length mismatch');
            return { valid: false, error: 'Invalid signature' };
        }

        if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
            console.warn('⚠️ Web demo token HMAC mismatch');
            return { valid: false, error: 'Invalid signature' };
        }

        return { valid: true, userId };
    } catch (err) {
        console.error('❌ Failed to validate web demo token:', err);
        return { valid: false, error: 'Token validation failed' };
    }
}

/**
 * Generate a web demo token (for testing/debugging purposes).
 * In production, this should be called from the web app backend.
 */
export function generateWebDemoToken(userId: string): string | null {
    if (!config.webDemoSharedSecret) {
        console.error('❌ WEB_DEMO_SHARED_SECRET not configured');
        return null;
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const data = `${timestamp}.${userId}`;

    const hmac = crypto
        .createHmac('sha256', config.webDemoSharedSecret)
        .update(data)
        .digest('hex');

    const token = Buffer.from(`${data}.${hmac}`).toString('base64url');
    return token;
}
