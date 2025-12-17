
import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
import { Client, WebhookEvent, MessageEvent, validateSignature } from '@line/bot-sdk';
import { config } from './config';

// LINE Client initialization
const lineClient = new Client({
    channelAccessToken: config.lineChannelAccessToken,
    channelSecret: config.lineChannelSecret,
});

const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);

export const handleLineWebhook = async (req: Request, res: Response) => {
    try {
        const events: WebhookEvent[] = req.body.events;

        // Process all events
        await Promise.all(events.map(event => processEvent(event)));

        res.status(200).json({ status: 'ok' });
    } catch (err) {
        console.error('❌ Error handling LINE webhook:', err);
        res.status(500).end();
    }
};

async function processEvent(event: WebhookEvent) {
    if (event.type !== 'message' || event.message.type !== 'text') {
        return;
    }

    const messageText = event.message.text.trim();
    const userIdSource = event.source.userId;

    if (!userIdSource) {
        return;
    }

    // Check if message is a linking command (e.g., "link <CODE>")
    // Or just the code itself if specific enough, but "link" prefix is safer as per request.
    const match = messageText.match(/^link\s+([a-zA-Z0-9]+)$/i);

    if (match) {
        const tokenCode = match[1];
        await handleLinkToken(event.replyToken, userIdSource, tokenCode);
    } else {
        // Optional: Reply with help message or ignore
        // await replyText(event.replyToken, '連携コードを送信する場合は "link [コード]" と入力してください。');
    }
}

async function handleLinkToken(replyToken: string, lineUserId: string, code: string) {
    // 1. Find valid token
    const now = new Date().toISOString();
    const { data: token, error: tokenError } = await supabase
        .from('line_link_tokens')
        .select('*')
        .eq('token_code', code)
        .is('used_at', null)
        .gt('expires_at', now)
        .single();

    if (tokenError || !token) {
        console.warn('⚠️ Invalid or expired token link attempt:', code);
        await replyText(replyToken, '無効または期限切れの連携コードです。もう一度発行してください。');
        return;
    }

    // 2. Update store_notification_settings (Upsert)
    // Existing values like notify_email_enabled will be preserved on update (PostgREST merge behavior),
    // or use default on insert.
    const { error: updateError } = await supabase
        .from('store_notification_settings')
        .upsert({
            user_id: token.user_id,
            line_target_id: lineUserId,
            notify_line_enabled: true,
            updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });

    if (updateError) {
        console.error(`❌ Failed to update settings. userId=${token.user_id}, token=${code}, lineId=${lineUserId}`, updateError);
        await replyText(replyToken, '連携処理中にエラーが発生しました。管理者にお問い合わせください。');
        return;
    }

    // 3. Mark token as used
    await supabase
        .from('line_link_tokens')
        .update({ used_at: new Date().toISOString() })
        .eq('id', token.id);

    // 4. Success reply
    await replyText(replyToken, '✅ LINE連携が完了しました！\n今後、予約リクエストが届くとここに通知されます。');
    console.log(`✅ User ${token.user_id} linked LINE account ${lineUserId}`);
}

async function replyText(replyToken: string, text: string) {
    try {
        await lineClient.replyMessage(replyToken, {
            type: 'text',
            text: text,
        });
    } catch (err) {
        console.error('❌ Failed to send LINE reply:', err);
    }
}
