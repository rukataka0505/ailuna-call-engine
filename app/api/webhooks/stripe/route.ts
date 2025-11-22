import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

// Initialize Stripe with secret key
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-11-20.acacia',
});

// Initialize Supabase Admin Client (bypasses RLS)
const supabaseAdmin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    }
);

/**
 * POST /api/webhooks/stripe
 * 
 * Handles Stripe webhook events for subscription management.
 * Processes checkout.session.completed and invoice.payment_succeeded events.
 */
export async function POST(request: NextRequest) {
    const body = await request.text();
    const signature = request.headers.get('stripe-signature');

    if (!signature) {
        console.error('❌ Missing stripe-signature header');
        return NextResponse.json(
            { error: 'Missing stripe-signature header' },
            { status: 400 }
        );
    }

    let event: Stripe.Event;

    // Verify webhook signature
    try {
        event = stripe.webhooks.constructEvent(
            body,
            signature,
            process.env.STRIPE_WEBHOOK_SECRET!
        );
        console.log(`✅ Webhook signature verified: ${event.type}`);
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`❌ Webhook signature verification failed: ${errorMessage}`);
        return NextResponse.json(
            { error: `Webhook signature verification failed: ${errorMessage}` },
            { status: 400 }
        );
    }

    // Handle specific event types
    try {
        switch (event.type) {
            case 'checkout.session.completed':
                await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
                break;

            case 'invoice.payment_succeeded':
                await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
                break;

            default:
                console.log(`ℹ️ Unhandled event type: ${event.type}`);
        }

        return NextResponse.json({ received: true }, { status: 200 });
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`❌ Error processing webhook event: ${errorMessage}`);

        // Return 200 to prevent Stripe from retrying for known errors
        // Only return 500 for unexpected server errors
        if (err instanceof Error && err.message.includes('No available phone numbers')) {
            console.error('⚠️ Phone number pool exhausted - returning 200 to prevent retry');
            return NextResponse.json({ received: true, warning: errorMessage }, { status: 200 });
        }

        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

/**
 * Handle checkout.session.completed event
 * Triggered when a customer completes the checkout process
 */
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    console.log(`📦 Processing checkout.session.completed: ${session.id}`);

    // Extract user ID from metadata or client_reference_id
    const userId = session.metadata?.userId || session.client_reference_id;
    const stripeCustomerId = session.customer as string;

    if (!userId) {
        console.error('❌ No userId found in session metadata or client_reference_id');
        return;
    }

    if (!stripeCustomerId) {
        console.error('❌ No customer ID found in session');
        return;
    }

    console.log(`👤 User ID: ${userId}, Stripe Customer ID: ${stripeCustomerId}`);

    // Update subscription status and assign phone number
    await updateSubscriptionAndAssignPhone(userId, stripeCustomerId);
}

/**
 * Handle invoice.payment_succeeded event
 * Triggered when a subscription payment succeeds (including renewals)
 */
async function handleInvoicePaymentSucceeded(invoice: Stripe.Invoice) {
    console.log(`💳 Processing invoice.payment_succeeded: ${invoice.id}`);

    const stripeCustomerId = invoice.customer as string;

    if (!stripeCustomerId) {
        console.error('❌ No customer ID found in invoice');
        return;
    }

    // Retrieve customer to get metadata
    const customer = await stripe.customers.retrieve(stripeCustomerId);

    if (customer.deleted) {
        console.error('❌ Customer has been deleted');
        return;
    }

    const userId = customer.metadata?.userId;

    if (!userId) {
        console.error('❌ No userId found in customer metadata');
        return;
    }

    console.log(`👤 User ID: ${userId}, Stripe Customer ID: ${stripeCustomerId}`);

    // Update subscription status and assign phone number
    await updateSubscriptionAndAssignPhone(userId, stripeCustomerId);
}

/**
 * Update user's subscription status and assign phone number if needed
 */
async function updateSubscriptionAndAssignPhone(userId: string, stripeCustomerId: string) {
    try {
        // 1. Update profiles table: set is_subscribed = true and stripe_customer_id
        console.log(`📝 Updating profile for user ${userId}...`);

        const { error: updateError } = await supabaseAdmin
            .from('profiles')
            .update({
                is_subscribed: true,
                stripe_customer_id: stripeCustomerId,
            })
            .eq('id', userId);

        if (updateError) {
            console.error(`❌ Failed to update profile: ${updateError.message}`);
            throw new Error(`Failed to update profile: ${updateError.message}`);
        }

        console.log(`✅ Profile updated successfully for user ${userId}`);

        // 2. Check if user already has a phone number
        const { data: profile, error: fetchError } = await supabaseAdmin
            .from('profiles')
            .select('phone_number')
            .eq('id', userId)
            .single();

        if (fetchError) {
            console.error(`❌ Failed to fetch profile: ${fetchError.message}`);
            throw new Error(`Failed to fetch profile: ${fetchError.message}`);
        }

        // 3. Assign phone number only if user doesn't have one
        if (!profile.phone_number) {
            console.log(`📞 Assigning phone number to user ${userId}...`);

            try {
                // Call RPC function to claim a phone number
                const { data: claimedNumber, error: rpcError } = await supabaseAdmin
                    .rpc('claim_phone_number', { target_user_id: userId });

                if (rpcError) {
                    console.error(`❌ Failed to claim phone number: ${rpcError.message}`);
                    throw new Error(`Failed to claim phone number: ${rpcError.message}`);
                }

                if (!claimedNumber) {
                    console.error('❌ No phone number returned from claim_phone_number');
                    throw new Error('No phone number returned from claim_phone_number');
                }

                // Update the profile with the claimed phone number
                const { error: phoneUpdateError } = await supabaseAdmin
                    .from('profiles')
                    .update({ phone_number: claimedNumber })
                    .eq('id', userId);

                if (phoneUpdateError) {
                    console.error(`❌ Failed to update phone number: ${phoneUpdateError.message}`);
                    throw new Error(`Failed to update phone number: ${phoneUpdateError.message}`);
                }

                console.log(`✅ Phone number ${claimedNumber} assigned to user ${userId}`);
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : 'Unknown error';

                // If no phone numbers available, log warning but don't fail the entire operation
                if (errorMessage.includes('No available phone numbers')) {
                    console.warn(`⚠️ No available phone numbers in pool for user ${userId}`);
                    // Re-throw to be handled by the main error handler
                    throw err;
                } else {
                    console.error(`❌ Error during phone number assignment: ${errorMessage}`);
                    throw err;
                }
            }
        } else {
            console.log(`ℹ️ User ${userId} already has phone number: ${profile.phone_number}`);
        }
    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error(`❌ Error in updateSubscriptionAndAssignPhone: ${errorMessage}`);
        throw err;
    }
}
