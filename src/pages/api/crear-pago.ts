import type { APIRoute } from 'astro';
import Stripe from 'stripe';

export const POST: APIRoute = async ({ request }) => {
  const stripeKey = import.meta.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe API key no configurada.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stripe = new Stripe(stripeKey);

  try {
    const { email, plan } = await request.json();

    if (!email || !plan) {
      return new Response(JSON.stringify({ error: 'Email y plan son requeridos.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const origin = new URL(request.url).origin;
    let sessionConfig: Stripe.Checkout.SessionCreateParams;

    if (plan === 'pago-unico') {
      sessionConfig = {
        automatic_payment_methods: { enabled: true },
        customer_email: email,
        line_items: [
          {
            price: import.meta.env.PRICE_ID_PAGO_UNICO,
            quantity: 1,
          },
        ],
        mode: 'payment',
        success_url: `${origin}/gracias?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
        cancel_url: `${origin}/pago-cancelado`,
      };
    } else if (plan === 'financiamiento-4') {
      sessionConfig = {
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [
          {
            price: import.meta.env.PRICE_ID_F4_INICIAL,
            quantity: 1,
          },
          {
            price: import.meta.env.PRICE_ID_F4_CUOTA,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        subscription_data: {
          trial_period_days: 30,
          metadata: {
            plan_type: 'financiamiento-4',
          },
        },
        success_url: `${origin}/gracias?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
        cancel_url: `${origin}/pago-cancelado`,
      };
    } else if (plan === 'financiamiento-6') {
      sessionConfig = {
        payment_method_types: ['card'],
        customer_email: email,
        line_items: [
          {
            price: import.meta.env.PRICE_ID_F6_INICIAL,
            quantity: 1,
          },
          {
            price: import.meta.env.PRICE_ID_F6_CUOTA,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        subscription_data: {
          trial_period_days: 30,
          metadata: {
            plan_type: 'financiamiento-6',
          },
        },
        success_url: `${origin}/gracias?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
        cancel_url: `${origin}/pago-cancelado`,
      };
    } else {
      return new Response(JSON.stringify({ error: 'Plan inválido.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const session = await stripe.checkout.sessions.create(sessionConfig);

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('Error al crear sesión de checkout:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
