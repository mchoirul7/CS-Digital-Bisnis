import type { BusinessToolContext } from "./recorder";
import type { OrderStatus } from "./order-types";

// Anchored to the whole message: "oke, tapi jangan pesan" is never consent.
export function isExplicitOrderConfirmation(message: string) {
  return /^(?:(?:ya|iya|oke|ok|setuju|konfirmasi|pesan|lanjut|gas|deal|sip)(?:\s+|[,!.]\s*)?)+(?:pesanan(?:nya)?(?:\s+ini)?|aja|saja|kak)?[.!\s]*$/i.test(message.trim());
}

export function normalizeCustomerPhone(value?: string | null) {
  if (!value) return null;
  let phone = value.replace(/[\s()-]/g, "");
  if (phone.startsWith("0")) phone = `+62${phone.slice(1)}`;
  else if (phone.startsWith("62")) phone = `+${phone}`;
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error("INVALID_CUSTOMER_PHONE");
  return phone;
}

export async function confirmOrder(context: BusinessToolContext, checkoutKey: string, message: string, phone?: string | null) {
  if (!context.conversationId || !isExplicitOrderConfirmation(message)) throw new Error("EXPLICIT_CONFIRMATION_REQUIRED");
  return context.recorder.run("confirm_order", { checkout_key: checkoutKey }, () => context.repository.confirmOrder({
    companyId: context.companyId, conversationId: context.conversationId!, checkoutKey, phone: normalizeCustomerPhone(phone),
  }));
}

// Creation and confirmation share one transaction; no partial persisted draft.
export const createOrder = confirmOrder;

export async function cancelOrder(context: BusinessToolContext, orderId: string) {
  return context.recorder.run("cancel_order", { order_id: orderId }, () =>
    context.repository.changeOrderStatus(context.companyId, orderId, "cancelled"));
}

export async function getOrder(context: BusinessToolContext, orderId: string) {
  return context.recorder.run("get_order", { order_id: orderId }, () => context.repository.getOrder(context.companyId, orderId));
}

export async function listOrders(context: BusinessToolContext, status?: OrderStatus, offset = 0) {
  return context.recorder.run("list_orders", { status: status ?? null, offset }, () => context.repository.listOrders(context.companyId, status, offset));
}
