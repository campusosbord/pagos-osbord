import type { APIRoute } from 'astro';
import Stripe from 'stripe';

export const POST: APIRoute = async ({ request }) => {
  const stripeKey = import.meta.env.STRIPE_SECRET_KEY;
  const webhookSecret = import.meta.env.STRIPE_WEBHOOK_SECRET;

  if (!stripeKey || !webhookSecret) {
    return new Response('Configuración de Stripe incompleta', { status: 500 });
  }

  const stripe = new Stripe(stripeKey);
  const signature = request.headers.get('stripe-signature');

  if (!signature) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  let event: Stripe.Event;

  try {
    const rawBody = await request.text();
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error(`[Webhook] Error de verificación: ${err.message}`);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // checkout.session.completed — programar cancelación automática
  //
  // CÁLCULO CORRECTO DEL cancel_at:
  //
  // El error anterior era usar "fecha_actual + N meses + 15 días", lo cual
  // caía a mitad de un período de facturación y Stripe prorrateaba el último
  // cobro (ej: $300 × 15/30 = $150 en vez del $300 completo).
  //
  // La solución es usar billing_cycle_anchor (la fecha real del primer cobro
  // recurrente tras el trial) como base:
  //   cancel_at = billing_cycle_anchor + N meses
  //
  // Cuando cancel_at coincide EXACTAMENTE con la fecha de renovación,
  // Stripe CANCELA en vez de renovar → ningún cobro extra, sin proration.
  //
  // Ejemplo plan 4 meses (inicio: 5 jun, trial 30d):
  //   billing_cycle_anchor = 5 jul (primer cobro real)
  //   Cuota 1: 5 jul  →  Cuota 2: 5 ago  →  Cuota 3: 5 sep  (última)
  //   cancel_at = 5 jul + 3 meses = 5 oct
  //   → El 5 oct Stripe cancela en vez de cobrar. ✅ Sin proration.
  //
  // Ejemplo plan 6 meses (inicio: 5 jun, trial 30d):
  //   billing_cycle_anchor = 5 jul
  //   Cuotas 1-5: 5 jul, 5 ago, 5 sep, 5 oct, 5 nov (última)
  //   cancel_at = 5 jul + 5 meses = 5 dic
  //   → El 5 dic Stripe cancela en vez de cobrar. ✅ Sin proration.
  // ─────────────────────────────────────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    console.log(`[Webhook] checkout.session.completed recibido. Mode: ${session.mode}`);

    if (session.mode === 'subscription' && session.subscription) {
      const subscriptionId = session.subscription as string;
      console.log(`[Webhook] Procesando suscripción: ${subscriptionId}`);

      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const planName = subscription.metadata?.plan_type;

        console.log(`[Webhook] plan_type detectado: "${planName}"`);

        if (planName !== 'financiamiento-4' && planName !== 'financiamiento-6') {
          console.warn(`[Webhook] plan_type inválido o ausente: "${planName}". Se omite la programación.`);
          return new Response(JSON.stringify({ received: true }), { status: 200 });
        }

        // 1. Crear el Subscription Schedule a partir de la suscripción existente
        const schedule = await stripe.subscriptionSchedules.create({
          from_subscription: subscriptionId,
        });

        console.log(`[Webhook] Subscription Schedule creado: ${schedule.id}`);

        if (!schedule.phases || schedule.phases.length === 0) {
          throw new Error('El schedule creado no tiene fases.');
        }

        // 2. Mapear la primera fase (que corresponde al periodo de trial de 30 días)
        const firstPhase = schedule.phases[0];
        const formattedFirstPhase = {
          start_date: firstPhase.start_date,
          end_date: firstPhase.end_date,
          items: firstPhase.items.map(item => ({
            price: typeof item.price === 'string' ? item.price : item.price.id,
            quantity: item.quantity,
          })),
          trial_end: firstPhase.trial_end || undefined,
          proration_behavior: 'none' as const,
        };

        // 3. Crear la segunda fase para los cobros recurrentes posteriores
        const cuotasCount = planName === 'financiamiento-4' ? 3 : 5;
        const recurringPriceId = planName === 'financiamiento-4'
          ? import.meta.env.PRICE_ID_F4_CUOTA
          : import.meta.env.PRICE_ID_F6_CUOTA;

        const secondPhase = {
          items: [
            {
              price: recurringPriceId,
              quantity: 1,
            }
          ],
          duration: {
            interval: 'month' as const,
            interval_count: cuotasCount,
          },
          proration_behavior: 'none' as const,
        };

        // 4. Actualizar el schedule con las dos fases consecutivas y end_behavior: 'cancel'
        await stripe.subscriptionSchedules.update(schedule.id, {
          end_behavior: 'cancel',
          phases: [formattedFirstPhase, secondPhase],
        });

        console.log(
          `[Webhook] ✅ Subscription Schedule configurado con éxito.\n` +
          `  Suscripción : ${subscriptionId}\n` +
          `  Schedule    : ${schedule.id}\n` +
          `  Plan        : ${planName} (Fase 1: Trial, Fase 2: ${cuotasCount} cuotas)\n` +
          `  Fin del Plan: Cancelación automática nativa al terminar las cuotas.`
        );
      } catch (err: any) {
        console.error(`[Webhook] ❌ Error al programar schedule:`, err.message);
        return new Response('Error al actualizar suscripción', { status: 500 });
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), { status: 200 });
};
