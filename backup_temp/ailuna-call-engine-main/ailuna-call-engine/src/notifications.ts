
import nodemailer from 'nodemailer';
import { Client as LineClient } from '@line/bot-sdk';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

interface ReservationRequest {
    id?: string;
    user_id: string;
    customer_name: string | null;
    customer_phone: string | null;
    party_size: number | null;
    requested_date: string | null;
    requested_time: string | null;
    requested_datetime_text: string | null;
    answers: Record<string, any>;
    created_at?: string;
}

export class NotificationService {
    private supabase: SupabaseClient;
    private lineClient?: LineClient;
    private mailTransporter?: nodemailer.Transporter;

    constructor() {
        this.supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

        // Initialize LINE Client if credentials are preset
        // (Note: credentials might be empty if not used, so we handle that gracefully)
        if (config.lineChannelAccessToken && config.lineChannelSecret) {
            this.lineClient = new LineClient({
                channelAccessToken: config.lineChannelAccessToken,
                channelSecret: config.lineChannelSecret,
            });
        }

        // Initialize Mail Transporter if SMTP host is present
        if (config.smtpHost) {
            this.mailTransporter = nodemailer.createTransport({
                host: config.smtpHost,
                port: config.smtpPort,
                secure: config.smtpPort === 465, // True for 465, false for other ports
                auth: config.smtpUser ? {
                    user: config.smtpUser,
                    pass: config.smtpPass,
                } : undefined,
            });
        }
    }

    public async notifyReservation(request: ReservationRequest) {
        if (!request.user_id) return;

        // 1. Fetch notification settings
        const { data: settings, error } = await this.supabase
            .from('store_notification_settings')
            .select('*')
            .eq('user_id', request.user_id)
            .single();

        if (error || !settings) {
            console.warn('⚠️ Notification settings not found for user:', request.user_id);
            return;
        }

        const dashboardUrl = `${config.webAppUrl}/dashboard`;
        // Assuming dashboard URL format. 
        // Ideally this might be a separate config or base URL. 
        // Using config.publicUrl if available or falling back to a known base if implemented differently.
        // For now, let's construct a generic message.

        // Construct Message
        const messageBody = this.constructMessage(request, dashboardUrl);

        // 2. Email Notification
        if (settings.notify_email_enabled && settings.notify_emails && settings.notify_emails.length > 0) {
            if (this.mailTransporter) {
                await this.sendEmail(settings.notify_emails, messageBody);
            } else {
                console.warn('⚠️ Email notification enabled but SMTP not configured.');
            }
        }

        // 3. LINE Notification
        if (settings.notify_line_enabled && settings.line_target_id) {
            if (this.lineClient) {
                await this.sendLine(settings.line_target_id, messageBody);
            } else {
                console.warn('⚠️ LINE notification enabled but LINE credentials not configured.');
            }
        }
    }

    private constructMessage(r: ReservationRequest, url: string): string {
        const lines = [
            '【新規予約リクエスト】',
            '',
            `日時: ${r.requested_date || ''} ${r.requested_time || ''} (${r.requested_datetime_text || '不明'})`,
            `人数: ${r.party_size ? r.party_size + '名' : '不明'}`,
            `お名前: ${r.customer_name || '不明'}`,
            `電話番号: ${r.customer_phone || '不明'}`,
        ];

        if (r.answers && Object.keys(r.answers).length > 0) {
            lines.push('-------------------');
            lines.push('ヒアリング回答:');
            for (const [key, val] of Object.entries(r.answers)) {
                lines.push(`${key}: ${val}`);
            }
        }

        lines.push('');
        lines.push('▼ダッシュボードで確認');
        lines.push(url);

        return lines.join('\n');
    }

    private async sendEmail(toAddresses: string[], body: string) {
        try {
            console.log(`📧 Sending email to ${toAddresses.length} recipients...`);
            await this.mailTransporter?.sendMail({
                from: config.emailFrom || 'no-reply@ailuna.app',
                to: toAddresses.join(','),
                subject: '【AiLuna】新規予約リクエストを受信しました',
                text: body,
            });
            console.log('✅ Email notification sent.');
        } catch (err) {
            console.error('❌ Failed to send email:', err);
        }
    }

    private async sendLine(targetId: string, body: string) {
        try {
            console.log(`💬 Sending LINE message to ${targetId}...`);
            await this.lineClient?.pushMessage(targetId, {
                type: 'text',
                text: body,
            });
            console.log('✅ LINE notification sent.');
        } catch (err) {
            console.error('❌ Failed to send LINE message:', err);
        }
    }
}

export const notificationService = new NotificationService();
