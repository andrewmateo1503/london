export type PaymentCode = "cash" | "transfer" | "card" | "other";
export type Category = { id: string; name: string; active: boolean };
export type Product = {
  id: string; name: string; price: number; category_id: string | null;
  category?: Category | null; active: boolean;
};
export type InvoiceItem = {
  id?: string; product_id: string | null; product_name: string;
  quantity: number; unit_price: number; line_total: number;
};
export type InvoiceVoid = { id?: string; reason: string; voided_at: string };
export type Invoice = {
  id: string; order_number: string; sold_at: string; person_name: string;
  person_name_normalized: string; payment_method: PaymentCode; total: number;
  amount_received: number; change_amount: number; notes: string | null;
  status: "completed" | "voided"; idempotency_key: string;
  invoice_items: InvoiceItem[]; invoice_voids?: InvoiceVoid[];
};
export type CartLine = { productId: string; name: string; quantity: number; price: number };
export type NewInvoice = {
  personName: string; paymentMethod: PaymentCode; amountReceived: number;
  notes: string; items: CartLine[]; idempotencyKey: string;
};
export const PAYMENT_LABELS: Record<PaymentCode, string> = {
  cash: "Efectivo", transfer: "Transferencia", card: "Tarjeta", other: "Otro",
};
