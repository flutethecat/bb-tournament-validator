<script setup lang="ts">
// "Pay entry fee" block (owner 11-02, links only), shown inside a competition's overview panel when the organiser set a
// PayPal or Venmo link: the entry fee text, the link buttons (new tab, rel="noopener noreferrer"), the viewer's own
// payment status when given, and the note that payment goes straight to the organiser. Only links that pass
// safePaymentLinks (paypal.me / paypal.com and venmo.com) become hrefs.
//
// The "PayPal" and "Venmo" badges are in-house SVG text badges drawn here (plain text on a token-coloured frame), not the
// services' logo files (asset-provenance law; record: tools/art/pay-badges/PROVENANCE.md).
import { computed } from "vue";
import { PAY_NOTE, paymentStatusText, safePaymentLinks, type PaymentLinks } from "../shared/payLinks";
import "../shared/pay-links.css";

const props = defineProps<{
  /** Prefix for element ids (one block per page). */
  idPrefix: string;
  entryFee?: string;
  links?: PaymentLinks | null;
  /** The viewer's own entries: label (team name, or "" for a single entry) and whether an organiser marked it paid. */
  status?: Array<{ label: string; paid: boolean }>;
  /** Tournament registration (lane L4): the viewer's own payment reference for the PayPal / Venmo note, and their
   *  "I've paid" (only the coach and the organisers ever see either). `claimable` shows the button. */
  refCode?: string;
  coachSaysPaid?: boolean;
  paid?: boolean;
  claimable?: boolean;
  busy?: boolean;
}>();
const emit = defineEmits<{ claim: [paid: boolean] }>();
const safe = computed(() => safePaymentLinks(props.links));
const fee = computed(() => (props.entryFee ?? "").trim());
const headingId = computed(() => `${props.idPrefix}-pay-h`);
</script>

<template>
  <div v-if="safe || status?.length || refCode" class="pay-block" role="group" :aria-labelledby="headingId" data-pay-block="true">
    <h3 :id="headingId" class="pay-h">Pay entry fee</h3>
    <p v-if="fee" class="pay-fee">{{ fee }}</p>
    <div v-if="safe" class="pay-links">
      <a
        v-if="safe.payPal" class="sf-btn small pay-btn" data-pay="paypal" :href="safe.payPal" target="_blank" rel="noopener noreferrer"
        aria-label="Pay with PayPal (opens in a new tab)"
      >
        <svg class="pay-badge" data-badge="paypal" viewBox="0 0 64 20" width="64" height="20" aria-hidden="true" focusable="false">
          <rect class="pay-badge-frame" x="1" y="1" width="62" height="18" rx="2" />
          <text class="pay-badge-text" x="32" y="14.5" text-anchor="middle">PayPal</text>
        </svg>
      </a>
      <a
        v-if="safe.venmo" class="sf-btn small pay-btn" data-pay="venmo" :href="safe.venmo.url" target="_blank" rel="noopener noreferrer"
        :aria-label="`Pay @${safe.venmo.handle} with Venmo (opens in a new tab)`"
      >
        <svg class="pay-badge" data-badge="venmo" viewBox="0 0 64 20" width="64" height="20" aria-hidden="true" focusable="false">
          <rect class="pay-badge-frame" x="1" y="1" width="62" height="18" rx="2" />
          <text class="pay-badge-text" x="32" y="14.5" text-anchor="middle">Venmo</text>
        </svg>
        <span class="pay-handle">@{{ safe.venmo.handle }}</span>
      </a>
    </div>
    <ul v-if="status?.length" class="pay-status" aria-label="Your payment">
      <li v-for="(s, i) in status" :key="i" :data-paid="s.paid ? 'true' : 'false'">
        <template v-if="s.label">{{ s.label }}: </template>{{ paymentStatusText(s.paid) }}
      </li>
    </ul>
    <p v-if="refCode" class="pay-ref" data-ref-code="true">
      <span>Your reference</span><code class="pay-ref-code">{{ refCode }}</code>
      <span class="muted">Put it in the payment note so the organiser can match it.</span>
    </p>
    <div v-if="refCode && claimable && !paid" class="pay-claim">
      <button v-if="!coachSaysPaid" type="button" class="sf-btn small primary" data-claim="paid" :disabled="busy" @click="emit('claim', true)">I've paid</button>
      <template v-else>
        <span class="sf-chip" data-tone="soon" data-claim="said">You said you paid</span>
        <button type="button" class="sf-btn small" :disabled="busy" @click="emit('claim', false)">Undo</button>
      </template>
      <span class="muted">The organiser checks the payment and marks it received.</span>
    </div>
    <p class="pay-note">{{ PAY_NOTE }}</p>
  </div>
</template>
