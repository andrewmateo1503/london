"use client";

import { createClient } from "@supabase/supabase-js";
import type { Category, Invoice, NewInvoice, PaymentCode, Product } from "./types";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
export const databaseConfigured = Boolean(url && key);
const db = databaseConfigured ? createClient(url!, key!, { auth: { persistSession: false } }) : null;

export function makeId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const categories: Category[] = [
  { id: "10000000-0000-4000-8000-000000000001", name: "Comida", active: true },
  { id: "10000000-0000-4000-8000-000000000002", name: "Bebidas", active: true },
  { id: "10000000-0000-4000-8000-000000000003", name: "Combos", active: true },
];
const products: Product[] = [
  ["20000000-0000-4000-8000-000000000001", "Hamburguesa", 3.5, 0],
  ["20000000-0000-4000-8000-000000000002", "Salchipapa", 3, 0],
  ["20000000-0000-4000-8000-000000000003", "Papas fritas", 2, 0],
  ["20000000-0000-4000-8000-000000000004", "Gaseosa", 1, 1],
  ["20000000-0000-4000-8000-000000000005", "Agua", 0.75, 1],
  ["20000000-0000-4000-8000-000000000006", "Combo", 5, 2],
  ["20000000-0000-4000-8000-000000000007", "Porción adicional", 1.5, 0],
].map(([id, name, price, cat]) => ({
  id: String(id), name: String(name), price: Number(price),
  category_id: categories[Number(cat)].id, category: categories[Number(cat)], active: true,
}));

const storageKey = "lfh-demo-data-v3";
const localTime = (hour: number) => { const d = new Date(); d.setHours(hour, 10, 0, 0); return d.toISOString(); };
const ecuadorDayCode = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
};
const demoInvoices = (): Invoice[] => [
  {
    id: "30000000-0000-4000-8000-000000000001", order_number: "LFH-DEMO-001",
    sold_at: localTime(10), person_name: "Andrea", person_name_normalized: "andrea",
    payment_method: "cash", total: 8, amount_received: 10, change_amount: 2,
    notes: "Sin salsas en una hamburguesa", status: "completed", idempotency_key: "demo-001",
    invoice_items: [
      { product_id: products[0].id, product_name: "Hamburguesa", quantity: 2, unit_price: 3.5, line_total: 7 },
      { product_id: products[3].id, product_name: "Gaseosa", quantity: 1, unit_price: 1, line_total: 1 },
    ],
  },
  {
    id: "30000000-0000-4000-8000-000000000002", order_number: "LFH-DEMO-002",
    sold_at: localTime(12), person_name: "Camila", person_name_normalized: "camila",
    payment_method: "transfer", total: 8, amount_received: 8, change_amount: 0,
    notes: null, status: "completed", idempotency_key: "demo-002",
    invoice_items: [
      { product_id: products[5].id, product_name: "Combo", quantity: 1, unit_price: 5, line_total: 5 },
      { product_id: products[1].id, product_name: "Salchipapa", quantity: 1, unit_price: 3, line_total: 3 },
    ],
  },
];
type State = { products: Product[]; categories: Category[]; invoices: Invoice[] };
function localState(): State {
  const raw = typeof window !== "undefined" ? localStorage.getItem(storageKey) : null;
  if (raw) try { return JSON.parse(raw) as State; } catch { /* restore */ }
  const state = { products, categories, invoices: demoInvoices() };
  if (typeof window !== "undefined") localStorage.setItem(storageKey, JSON.stringify(state));
  return state;
}
const persist = (state: State) => localStorage.setItem(storageKey, JSON.stringify(state));

function invoice(row: Record<string, unknown>): Invoice {
  return {
    ...(row as unknown as Invoice),
    total: Number(row.total), amount_received: Number(row.amount_received),
    change_amount: Number(row.change_amount),
    invoice_items: ((row.invoice_items ?? []) as Record<string, unknown>[]).map((i) => ({
      ...(i as unknown as Invoice["invoice_items"][number]),
      quantity: Number(i.quantity), unit_price: Number(i.unit_price), line_total: Number(i.line_total),
    })),
  };
}

export async function loadAll(): Promise<State> {
  if (!db) return localState();
  const [c, p, i] = await Promise.all([
    db.from("categories").select("*").order("name"),
    db.from("products").select("*, category:categories(id,name,active)").order("name"),
    db.from("invoices").select("*, invoice_items(*), invoice_voids(*)").order("sold_at", { ascending: false }).limit(1500),
  ]);
  const error = c.error ?? p.error ?? i.error;
  if (error) throw new Error(error.message);
  return {
    categories: (c.data ?? []) as Category[],
    products: (p.data ?? []).map((row) => ({ ...row, price: Number(row.price) })) as Product[],
    invoices: (i.data ?? []).map((row) => invoice(row as Record<string, unknown>)),
  };
}

export async function saveProduct(product: Partial<Product> & { name: string; price: number }) {
  if (!db) {
    const state = localState();
    const old = state.products.find((p) => p.id === product.id);
    if (old) Object.assign(old, product, { category: state.categories.find((c) => c.id === product.category_id) ?? null });
    else state.products.push({ id: makeId(), name: product.name.trim(), price: product.price,
      category_id: product.category_id ?? null, category: state.categories.find((c) => c.id === product.category_id) ?? null,
      active: product.active ?? true });
    persist(state); return;
  }
  const payload = { name: product.name.trim(), price: product.price, category_id: product.category_id || null, active: product.active ?? true };
  const result = product.id ? await db.from("products").update(payload).eq("id", product.id) : await db.from("products").insert(payload);
  if (result.error) throw new Error(result.error.message);
}

export async function toggleProduct(id: string, active: boolean) {
  if (!db) { const state = localState(); const p = state.products.find((x) => x.id === id); if (p) p.active = active; persist(state); return; }
  const { error } = await db.from("products").update({ active }).eq("id", id);
  if (error) throw new Error(error.message);
}

export async function createInvoice(input: NewInvoice) {
  if (!db) {
    const state = localState();
    const old = state.invoices.find((i) => i.idempotency_key === input.idempotencyKey);
    if (old) return old.order_number;
    const total = input.items.reduce((s, x) => s + x.quantity * x.price, 0);
    const code = ecuadorDayCode();
    const order = `LFH-${code}-${String(state.invoices.filter((i) => i.order_number.includes(code)).length + 1).padStart(3, "0")}`;
    state.invoices.unshift({
      id: makeId(), order_number: order, sold_at: new Date().toISOString(),
      person_name: input.personName.trim(), person_name_normalized: input.personName.trim().toLowerCase(),
      payment_method: input.paymentMethod, total, amount_received: input.amountReceived,
      change_amount: input.paymentMethod === "cash" ? Math.max(0, input.amountReceived - total) : 0,
      notes: input.notes.trim() || null, status: "completed", idempotency_key: input.idempotencyKey,
      invoice_items: input.items.map((x) => ({ id: makeId(), product_id: x.productId,
        product_name: x.name, quantity: x.quantity, unit_price: x.price, line_total: x.quantity * x.price })),
    });
    persist(state); return order;
  }
  const { data, error } = await db.rpc("create_invoice", {
    p_person_name: input.personName.trim(), p_payment_method: input.paymentMethod,
    p_amount_received: input.amountReceived, p_notes: input.notes.trim() || null,
    p_idempotency_key: input.idempotencyKey,
    p_items: input.items.map((x) => ({ product_id: x.productId, product_name: x.name, quantity: x.quantity, unit_price: x.price })),
  });
  if (error) throw new Error(error.message);
  return String(data);
}

export async function voidInvoice(id: string, reason: string) {
  if (!db) {
    const state = localState(); const i = state.invoices.find((x) => x.id === id);
    if (!i) throw new Error("No se encontró la factura.");
    i.status = "voided"; i.invoice_voids = [{ id: makeId(), reason, voided_at: new Date().toISOString() }];
    persist(state); return;
  }
  const { error } = await db.rpc("void_invoice", { p_invoice_id: id, p_reason: reason.trim() });
  if (error) throw new Error(error.message);
}
export const paymentCodes: PaymentCode[] = ["cash", "transfer", "card", "other"];
export const resetDemoData = () => localStorage.removeItem(storageKey);
