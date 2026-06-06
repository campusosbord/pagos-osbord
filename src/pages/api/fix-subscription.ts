/**
 * ENDPOINT DE UTILIDAD — Corregir cancel_at de una suscripción activa
 *
 * Usa la misma lógica que el webhook: calcula cancel_at a partir del
 * billing_cycle_anchor real de Stripe (sin proration).
 *
 * Uso (solo en modo test/desarrollo):
 * GET /api/fix-subscription?sub_id=sub_XXXX&plan=financiamiento-4
 *
 * ⚠️ ELIMINA este archivo antes de ir a producción.
 */
import type { APIRoute } from 'astro';
import Stripe from 'stripe';

export const GET: APIRoute = async ({ request }) => {
  const stripe = new Stripe(import.meta.env.STRIPE_SECRET_KEY || '');
  const url = new URL(request.url);
  const subId = url.searchParams.get('sub_id');
  const plan = url.searchParams.get('plan');

  if (!subId || !plan) {
    return new Response(
      JSON.stringify({ error: 'Parámetros sub_id y plan son requeridos.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (plan !== 'financiamiento-4' && plan !== 'financiamiento-6') {
    return new Response(
      JSON.stringify({ error: 'Plan inválido. Usa financiamiento-4 o financiamiento-6.' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const subscription = await stripe.subscriptions.retrieve(subId);

    // 1. Crear o recuperar el Subscription Schedule
    let schedule;
    if (subscription.schedule) {
      schedule = await stripe.subscriptionSchedules.retrieve(subscription.schedule as string);
    } else {
      schedule = await stripe.subscriptionSchedules.create({
        from_subscription: subId,
      });
    }

    if (!schedule.phases || schedule.phases.length === 0) {
      throw new Error('El schedule no tiene fases.');
    }

    // 2. Mapear la primera fase
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

    // 3. Crear la segunda fase para los cobros recurrentes
    const cuotasCount = plan === 'financiamiento-4' ? 3 : 5;
    const recurringPriceId = plan === 'financiamiento-4'
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

    // 4. Actualizar el schedule
    const updatedSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
      end_behavior: 'cancel',
      phases: [formattedFirstPhase, secondPhase],
    });

    return new Response(
      JSON.stringify({
        success: true,
        subscription_id: subId,
        schedule_id: updatedSchedule.id,
        plan,
        cuotas_count: cuotasCount,
        phases: updatedSchedule.phases,
        status: updatedSchedule.status,
        note: 'Suscripción migrada a Subscription Schedule de forma nativa con duración de fases.',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
