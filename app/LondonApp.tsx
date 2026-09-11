"use client";

import { useEffect, useMemo, useState } from "react";
import { createInvoice, databaseConfigured, loadAll, makeId, paymentCodes, resetDemoData, saveProduct, toggleProduct, voidInvoice } from "@/lib/data";
import { PAYMENT_LABELS, type CartLine, type Category, type Invoice, type PaymentCode, type Product } from "@/lib/types";

type View = "sale" | "summary" | "people" | "history" | "reports" | "products";
type Notice = { kind: "ok" | "error"; text: string } | null;
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const localDate = new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", dateStyle: "medium", timeStyle: "short" });
const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit" });
const norm = (text: string) => text.trim().toLocaleLowerCase("es").replace(/\s+/g, " ");
const day = (value: Date | string) => {
  const parts = dateFormatter.formatToParts(typeof value === "string" ? new Date(value) : value);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

function stats(invoices: Invoice[]) {
  const valid = invoices.filter((i) => i.status === "completed");
  const pay: Record<PaymentCode, number> = { cash: 0, transfer: 0, card: 0, other: 0 };
  const products = new Map<string, { name: string; quantity: number; total: number }>();
  const people = new Map<string, { name: string; invoices: number; total: number; products: number; pay: Record<PaymentCode, number> }>();
  valid.forEach((invoice) => {
    pay[invoice.payment_method] += invoice.total;
    const key = norm(invoice.person_name);
    const person = people.get(key) ?? { name: invoice.person_name, invoices: 0, total: 0, products: 0, pay: { cash: 0, transfer: 0, card: 0, other: 0 } };
    person.invoices++; person.total += invoice.total; person.pay[invoice.payment_method] += invoice.total;
    invoice.invoice_items.forEach((item) => {
      person.products += item.quantity;
      const pkey = norm(item.product_name);
      const product = products.get(pkey) ?? { name: item.product_name, quantity: 0, total: 0 };
      product.quantity += item.quantity; product.total += item.line_total; products.set(pkey, product);
    });
    people.set(key, person);
  });
  const total = valid.reduce((sum, i) => sum + i.total, 0);
  const countProducts = valid.flatMap((i) => i.invoice_items).reduce((sum, i) => sum + i.quantity, 0);
  return {
    total, count: valid.length, voids: invoices.length - valid.length, pay, countProducts,
    average: valid.length ? total / valid.length : 0,
    products: [...products.values()].sort((a, b) => b.quantity - a.quantity),
    people: [...people.values()].sort((a, b) => b.total - a.total),
  };
}

function Header({ view, select }: { view: View; select: (view: View) => void }) {
  const links: [View, string, string][] = [
    ["sale", "Nueva venta", "＋"], ["summary", "Resumen", "⌁"], ["people", "Personas", "◎"],
    ["history", "Historial", "▤"], ["reports", "Reportes", "↗"], ["products", "Productos", "◇"],
  ];
  return <>
    <header className="topbar">
      <button className="brand" onClick={() => select("sale")}><b>L</b><span><strong>London</strong><small>Frozen &amp; Hot</small></span></button>
      <nav>{links.map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => select(id)}><i>{icon}</i>{label}</button>)}</nav>
      <span className="country">Ecuador · USD</span>
    </header>
    <nav className="mobile-nav">{links.slice(0, 5).map(([id, label, icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => select(id)}><i>{icon}</i><small>{label.replace("Nueva ", "")}</small></button>)}</nav>
  </>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><b>◇</b><strong>{title}</strong><p>{text}</p></div>;
}

function Sale({ products, invoices, refresh, notify }: { products: Product[]; invoices: Invoice[]; refresh: () => Promise<void>; notify: (n: Notice) => void }) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [search, setSearch] = useState("");
  const [person, setPerson] = useState("");
  const [payment, setPayment] = useState<PaymentCode>("cash");
  const [received, setReceived] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [requestId, setRequestId] = useState(() => makeId());
  const total = cart.reduce((sum, line) => sum + line.quantity * line.price, 0);
  const paid = payment === "cash" ? Number(received || 0) : total;
  const change = payment === "cash" ? Math.max(0, paid - total) : 0;
  const suggestions = [...new Map(invoices.map((i) => [norm(i.person_name), i.person_name])).values()];
  const visible = products.filter((p) => p.active && norm(p.name).includes(norm(search)));

  function add(product: Product) {
    setCart((lines) => lines.some((x) => x.productId === product.id)
      ? lines.map((x) => x.productId === product.id ? { ...x, quantity: x.quantity + 1 } : x)
      : [...lines, { productId: product.id, name: product.name, quantity: 1, price: product.price }]);
  }
  function update(id: string, changes: Partial<CartLine>) {
    setCart((lines) => lines.map((x) => x.productId === id ? { ...x, ...changes } : x).filter((x) => x.quantity > 0));
  }
  async function save() {
    if (!person.trim()) return notify({ kind: "error", text: "Escribe el nombre de la persona." });
    if (!cart.length) return notify({ kind: "error", text: "Agrega al menos un producto." });
    if (payment === "cash" && paid < total) return notify({ kind: "error", text: `Faltan ${usd.format(total - paid)} para completar el pago.` });
    setSaving(true);
    try {
      const order = await createInvoice({ personName: person, paymentMethod: payment, amountReceived: paid, notes, items: cart, idempotencyKey: requestId });
      await refresh(); setCart([]); setPayment("cash"); setReceived(""); setNotes(""); setRequestId(makeId());
      notify({ kind: "ok", text: `Venta ${order} guardada correctamente.` });
    } catch (e) { notify({ kind: "error", text: e instanceof Error ? e.message : "No se pudo guardar." }); }
    finally { setSaving(false); }
  }
  return <main className="sale-layout">
    <section className="catalog">
      <div className="heading"><div><p>Registro de factura</p><h1>Nueva venta</h1></div><span><small>Ahora</small><b>{localDate.format(new Date())}</b></span></div>
      <label className="search"><i>⌕</i><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto..." />{search && <button onClick={() => setSearch("")}>×</button>}</label>
      <div className="product-grid">{visible.map((product) => {
        const quantity = cart.find((x) => x.productId === product.id)?.quantity;
        return <button className="product" key={product.id} onClick={() => add(product)}>
          <small>{product.category?.name ?? "Producto"}</small><strong>{product.name}</strong><b>{usd.format(product.price)}</b>{quantity ? <em>{quantity}</em> : null}
        </button>;
      })}</div>
      {!visible.length && <Empty title="Sin resultados" text="Prueba con otro nombre o activa el producto." />}
    </section>
    <aside className="invoice">
      <header><span><small>Factura actual</small><strong>{cart.reduce((s, x) => s + x.quantity, 0)} productos</strong></span>{cart.length > 0 && <button onClick={() => setCart([])}>Vaciar</button>}</header>
      <div className="cart">{cart.length ? cart.map((line) => <article key={line.productId}>
        <div><strong>{line.name}</strong><button onClick={() => setCart((x) => x.filter((i) => i.productId !== line.productId))}>×</button></div>
        <section><span className="stepper"><button onClick={() => update(line.productId, { quantity: line.quantity - 1 })}>−</button><input value={line.quantity} onChange={(e) => update(line.productId, { quantity: Math.max(1, Number(e.target.value)) })} /><button onClick={() => update(line.productId, { quantity: line.quantity + 1 })}>+</button></span>
          <label className="line-price">$<input value={line.price} onChange={(e) => update(line.productId, { price: Math.max(0, Number(e.target.value)) })} /></label><b>{usd.format(line.quantity * line.price)}</b></section>
      </article>) : <div className="empty-cart"><b>＋</b><span>Toca un producto para agregarlo</span></div>}</div>
      <div className="form">
        <label><span>Persona <b>*</b></span><input list="names" value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Escribe el nombre" /><datalist id="names">{suggestions.map((n) => <option value={n} key={n} />)}</datalist></label>
        <fieldset><legend>Método de pago</legend><div className="payments">{paymentCodes.map((code) => <button key={code} className={payment === code ? "active" : ""} onClick={() => setPayment(code)}>{PAYMENT_LABELS[code]}</button>)}</div></fieldset>
        {payment === "cash" && <label><span>Dinero recibido <b>*</b></span><div className="money-input">$<input value={received} onChange={(e) => setReceived(e.target.value)} inputMode="decimal" placeholder="0.00" /></div></label>}
        <label><span>Observaciones <small>Opcional</small></span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Ej. Sin salsas, pedido para llevar..." /></label>
      </div>
      <div className="totals"><p><span>Subtotal</span><b>{usd.format(total)}</b></p><p><span>Recibido</span><b>{usd.format(paid)}</b></p><p className="change"><span>Cambio</span><b>{usd.format(change)}</b></p><p className="grand"><span>Total</span><strong>{usd.format(total)}</strong></p></div>
      <button className="save" disabled={saving || !cart.length} onClick={save}>{saving ? "Guardando..." : <>Guardar factura <b>→</b></>}</button>
    </aside>
  </main>;
}

function Metrics({ data }: { data: ReturnType<typeof stats> }) {
  return <section className="metrics">
    <article className="dark"><span>Total vendido</span><strong>{usd.format(data.total)}</strong><small>{data.count} facturas válidas</small></article>
    <article className="green"><span>Productos vendidos</span><strong>{data.countProducts}</strong><small>{data.products[0] ? `Más vendido: ${data.products[0].name}` : "Sin ventas"}</small></article>
    <article className="purple"><span>Promedio por factura</span><strong>{usd.format(data.average)}</strong><small>Facturas no anuladas</small></article>
    <article><span>Facturas anuladas</span><strong>{data.voids}</strong><small>No suman a las ventas</small></article>
  </section>;
}

function PaymentBars({ data }: { data: ReturnType<typeof stats> }) {
  const max = Math.max(1, ...Object.values(data.pay));
  return <div className="payment-bars">{paymentCodes.map((code) => <div key={code}><p><span>{PAYMENT_LABELS[code]}</span><b>{usd.format(data.pay[code])}</b></p><i><em style={{ width: `${data.pay[code] / max * 100}%` }} /></i></div>)}</div>;
}

function InvoiceRows({ invoices, select }: { invoices: Invoice[]; select: (i: Invoice) => void }) {
  if (!invoices.length) return <Empty title="No hay facturas" text="Las ventas registradas aparecerán aquí." />;
  return <div className="invoice-list">{invoices.map((i) => <button key={i.id} onClick={() => select(i)}>
    <i className={i.status} /><span><strong>{i.order_number}</strong><small>{localDate.format(new Date(i.sold_at))}</small></span>
    <em>{i.person_name}</em><label>{PAYMENT_LABELS[i.payment_method]}</label><b className={i.status}>{usd.format(i.total)}</b><q>›</q>
  </button>)}</div>;
}

function Summary({ invoices, select }: { invoices: Invoice[]; select: (i: Invoice) => void }) {
  const today = invoices.filter((i) => day(i.sold_at) === day(new Date()));
  const data = stats(today);
  return <PageTitle kicker="Actividad actual" title="Resumen del día" subtitle={localDate.format(new Date())}>
    <Metrics data={data} />
    <div className="two-cols">
      <Card kicker="Distribución" title="Ventas por método"><PaymentBars data={data} /></Card>
      <Card kicker="Productos" title="Más vendidos hoy"><Ranking products={data.products} /></Card>
    </div>
    <Card kicker="Actividad reciente" title="Últimas facturas"><InvoiceRows invoices={today.slice(0, 8)} select={select} /></Card>
  </PageTitle>;
}

function PageTitle({ kicker, title, subtitle, actions, children }: { kicker: string; title: string; subtitle?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return <main className="page"><header className="page-title"><div><p>{kicker}</p><h1>{title}</h1>{subtitle && <span>{subtitle}</span>}</div>{actions}</header>{children}</main>;
}
function Card({ kicker, title, children, className = "" }: { kicker: string; title: string; children: React.ReactNode; className?: string }) {
  return <section className={`card ${className}`}><header><p>{kicker}</p><h2>{title}</h2></header>{children}</section>;
}
function Ranking({ products }: { products: ReturnType<typeof stats>["products"] }) {
  return <div className="ranking">{products.length ? products.slice(0, 8).map((p, index) => <div key={p.name}><b>{index + 1}</b><span><strong>{p.name}</strong><small>{p.quantity} unidades</small></span><em>{usd.format(p.total)}</em></div>) : <Empty title="Aún sin datos" text="No hay productos vendidos en este periodo." />}</div>;
}

function Personas({ invoices }: { invoices: Invoice[] }) {
  const [period, setPeriod] = useState<"today" | "month" | "all">("today");
  const now = new Date();
  const filtered = invoices.filter((i) => period === "all" || (period === "today" ? day(i.sold_at) === day(now) : new Date(i.sold_at).getMonth() === now.getMonth() && new Date(i.sold_at).getFullYear() === now.getFullYear()));
  const data = stats(filtered);
  const actions = <div className="tabs">{[["today", "Hoy"], ["month", "Este mes"], ["all", "Todo"]].map(([id, label]) => <button className={period === id ? "active" : ""} onClick={() => setPeriod(id as typeof period)} key={id}>{label}</button>)}</div>;
  return <PageTitle kicker="Rendimiento" title="Ventas por persona" subtitle="Los nombres se agrupan sin distinguir mayúsculas." actions={actions}>
    <div className="people-grid">{data.people.map((e, index) => <article key={norm(e.name)}>
      <header><b>{e.name[0]?.toUpperCase()}</b><span><strong>{e.name}</strong><small>{e.invoices} facturas</small></span>{index === 0 && data.people.length > 1 && <em>Mayor venta</em>}</header>
      <section><small>Total vendido</small><strong>{usd.format(e.total)}</strong></section>
      <dl>{paymentCodes.map((code) => <div key={code}><dt>{PAYMENT_LABELS[code]}</dt><dd>{usd.format(e.pay[code])}</dd></div>)}</dl>
      <footer><span>Productos vendidos</span><b>{e.products}</b></footer>
    </article>)}</div>
    {!data.people.length && <Empty title="Sin ventas en este periodo" text="Cambia el periodo o registra una factura." />}
  </PageTitle>;
}

function History({ invoices, select }: { invoices: Invoice[]; select: (i: Invoice) => void }) {
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [person, setPerson] = useState("");
  const [payment, setPayment] = useState<PaymentCode | "">(""); const [order, setOrder] = useState("");
  const filtered = invoices.filter((i) => (!from || day(i.sold_at) >= from) && (!to || day(i.sold_at) <= to) && (!person || norm(i.person_name).includes(norm(person))) && (!payment || i.payment_method === payment) && (!order || i.order_number.toLowerCase().includes(order.toLowerCase())));
  const clear = () => { setFrom(""); setTo(""); setPerson(""); setPayment(""); setOrder(""); };
  return <PageTitle kicker="Registro completo" title="Historial de facturas" subtitle={`${filtered.length} resultados`}>
    <section className="filters">
      <label><span>Desde</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label><span>Hasta</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <label><span>Persona</span><input value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Cualquier nombre" /></label>
      <label><span>Método</span><select value={payment} onChange={(e) => setPayment(e.target.value as PaymentCode | "")}><option value="">Todos</option>{paymentCodes.map((c) => <option key={c} value={c}>{PAYMENT_LABELS[c]}</option>)}</select></label>
      <label><span>Número de orden</span><input value={order} onChange={(e) => setOrder(e.target.value)} placeholder="LFH-..." /></label>
      <button onClick={clear}>Limpiar</button>
    </section>
    <Card kicker="Facturas" title="Resultados"><InvoiceRows invoices={filtered} select={select} /></Card>
  </PageTitle>;
}

function Reports({ invoices }: { invoices: Invoice[] }) {
  const now = new Date(); const [period, setPeriod] = useState<"today" | "yesterday" | "week" | "month" | "custom">("today");
  const [from, setFrom] = useState(inputDate(now)); const [to, setTo] = useState(inputDate(now));
  const range = useMemo(() => {
    const date = new Date();
    if (period === "custom") return { from, to };
    if (period === "today") return { from: inputDate(date), to: inputDate(date) };
    if (period === "yesterday") { date.setDate(date.getDate() - 1); return { from: inputDate(date), to: inputDate(date) }; }
    if (period === "week") { const d = date.getDay() || 7; const start = new Date(date); start.setDate(date.getDate() - d + 1); return { from: inputDate(start), to: inputDate(date) }; }
    return { from: inputDate(new Date(date.getFullYear(), date.getMonth(), 1)), to: inputDate(date) };
  }, [period, from, to]);
  const data = stats(invoices.filter((i) => day(i.sold_at) >= range.from && day(i.sold_at) <= range.to));
  return <PageTitle kicker="Análisis de ventas" title="Reportes por fechas" subtitle={`Del ${range.from} al ${range.to}`}>
    <section className="periods">{[["today", "Hoy"], ["yesterday", "Ayer"], ["week", "Esta semana"], ["month", "Este mes"], ["custom", "Rango personalizado"]].map(([id, label]) => <button key={id} className={period === id ? "active" : ""} onClick={() => setPeriod(id as typeof period)}>{label}</button>)}
      {period === "custom" && <div><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span>hasta</span><input type="date" min={from} value={to} onChange={(e) => setTo(e.target.value)} /></div>}</section>
    <Metrics data={data} />
    <div className="two-cols"><Card kicker="Ingresos" title="Por método de pago"><PaymentBars data={data} /></Card><Card kicker="Ranking" title="Productos más vendidos"><Ranking products={data.products} /></Card></div>
    <Card kicker="Equipo" title="Ventas por persona"><div className="people-report">{data.people.map((e) => <div key={norm(e.name)}><b>{e.name[0]}</b><span><strong>{e.name}</strong><small>{e.invoices} facturas · {e.products} productos</small></span><em>{usd.format(e.total)}</em></div>)}</div></Card>
  </PageTitle>;
}

function ProductModal({ product, categories, close, done, notify }: { product: Product | null; categories: Category[]; close: () => void; done: () => Promise<void>; notify: (n: Notice) => void }) {
  const [name, setName] = useState(product?.name ?? ""); const [price, setPrice] = useState(String(product?.price ?? ""));
  const [category, setCategory] = useState(product?.category_id ?? ""); const [active, setActive] = useState(product?.active ?? true); const [saving, setSaving] = useState(false);
  async function save() { setSaving(true); try { await saveProduct({ id: product?.id, name, price: Number(price), category_id: category || null, active }); await done(); notify({ kind: "ok", text: "Producto guardado correctamente." }); close(); } catch (e) { notify({ kind: "error", text: e instanceof Error ? e.message : "No se pudo guardar." }); } finally { setSaving(false); } }
  return <div className="overlay" onMouseDown={close}><section className="modal small" onMouseDown={(e) => e.stopPropagation()}><header><span><p>Administración</p><h2>{product ? "Editar producto" : "Nuevo producto"}</h2></span><button onClick={close}>×</button></header><main>
    <label><span>Nombre <b>*</b></span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
    <label><span>Precio <b>*</b></span><div className="money-input">$<input value={price} onChange={(e) => setPrice(e.target.value)} /></div></label>
    <label><span>Categoría <small>Opcional</small></span><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Sin categoría</option>{categories.map((c) => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
    <label className="switch"><span><strong>Producto activo</strong><small>Visible al registrar ventas</small></span><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /></label>
  </main><footer><button onClick={close}>Cancelar</button><button className="primary" disabled={saving || !name.trim() || Number(price) < 0} onClick={save}>{saving ? "Guardando..." : "Guardar producto"}</button></footer></section></div>;
}

function Products({ products, categories, refresh, notify }: { products: Product[]; categories: Category[]; refresh: () => Promise<void>; notify: (n: Notice) => void }) {
  const [editing, setEditing] = useState<Product | null | undefined>(undefined); const [search, setSearch] = useState("");
  const visible = products.filter((p) => norm(p.name).includes(norm(search)));
  return <PageTitle kicker="Catálogo" title="Administrar productos" subtitle={`${products.filter((p) => p.active).length} productos activos`} actions={<button className="primary" onClick={() => setEditing(null)}>＋ Nuevo producto</button>}>
    <label className="search product-search"><i>⌕</i><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar producto..." /></label>
    <section className="product-table"><header><span>Producto</span><span>Categoría</span><span>Precio</span><span>Estado</span><span /></header>{visible.map((p) => <article key={p.id}>
      <span className="product-name"><b>{p.name[0]}</b><strong>{p.name}</strong></span><span>{p.category?.name ?? "Sin categoría"}</span><strong>{usd.format(p.price)}</strong>
      <button className={`status ${p.active ? "active" : ""}`} onClick={async () => { try { await toggleProduct(p.id, !p.active); await refresh(); } catch (e) { notify({ kind: "error", text: String(e) }); } }}><i />{p.active ? "Activo" : "Inactivo"}</button>
      <button className="edit" onClick={() => setEditing(p)}>Editar</button>
    </article>)}</section>
    {editing !== undefined && <ProductModal product={editing} categories={categories} close={() => setEditing(undefined)} done={refresh} notify={notify} />}
  </PageTitle>;
}

function InvoiceModal({ invoice, close, refresh, notify }: { invoice: Invoice; close: () => void; refresh: () => Promise<void>; notify: (n: Notice) => void }) {
  const [confirm, setConfirm] = useState(false); const [reason, setReason] = useState(""); const [saving, setSaving] = useState(false); const voided = invoice.invoice_voids?.[0];
  return <div className="overlay" onMouseDown={close}><section className="modal" onMouseDown={(e) => e.stopPropagation()}><header><span><p>Detalle de factura</p><h2>{invoice.order_number}</h2></span><button onClick={close}>×</button></header><main>
    <div className="invoice-meta"><span><small>Fecha y hora</small><b>{localDate.format(new Date(invoice.sold_at))}</b></span><span><small>Persona</small><b>{invoice.person_name}</b></span><span><small>Método</small><b>{PAYMENT_LABELS[invoice.payment_method]}</b></span><span><small>Estado</small><b className={invoice.status}>{invoice.status === "completed" ? "Completada" : "Anulada"}</b></span></div>
    <div className="detail-lines"><header><span>Producto</span><span>Cant.</span><span>Precio</span><span>Total</span></header>{invoice.invoice_items.map((x, n) => <div key={x.id ?? n}><span>{x.product_name}</span><span>{x.quantity}</span><span>{usd.format(x.unit_price)}</span><b>{usd.format(x.line_total)}</b></div>)}</div>
    <div className="detail-total"><span><small>Total</small><strong>{usd.format(invoice.total)}</strong></span><span><small>Dinero recibido</small><b>{usd.format(invoice.amount_received)}</b></span><span><small>Cambio</small><b>{usd.format(invoice.change_amount)}</b></span></div>
    {invoice.notes && <aside className="notes"><small>Observaciones</small><p>{invoice.notes}</p></aside>}
    {voided && <aside className="void-info"><b>Factura anulada</b><p>{voided.reason}</p><small>{localDate.format(new Date(voided.voided_at))}</small></aside>}
    {confirm && <aside className="void-info confirm"><b>¿Anular esta factura?</b><p>Seguirá visible, pero dejará de sumarse a las ventas.</p><label><span>Motivo de anulación <b>*</b></span><textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Describe el motivo..." /></label></aside>}
  </main><footer><button onClick={close}>Cerrar</button>{invoice.status === "completed" && !confirm && <button className="danger" onClick={() => setConfirm(true)}>Anular factura</button>}{confirm && <><button onClick={() => setConfirm(false)}>Cancelar</button><button className="danger solid" disabled={!reason.trim() || saving} onClick={async () => { setSaving(true); try { await voidInvoice(invoice.id, reason); await refresh(); notify({ kind: "ok", text: `Factura ${invoice.order_number} anulada.` }); close(); } catch (e) { notify({ kind: "error", text: e instanceof Error ? e.message : "No se pudo anular." }); } finally { setSaving(false); } }}>{saving ? "Anulando..." : "Confirmar anulación"}</button></>}</footer></section></div>;
}

export default function LondonApp() {
  const [view, setView] = useState<View>("sale"); const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]); const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true); const [notice, setNotice] = useState<Notice>(null); const [selected, setSelected] = useState<Invoice | null>(null);
  async function refresh() { const data = await loadAll(); setProducts(data.products); setCategories(data.categories); setInvoices(data.invoices); }
  useEffect(() => {
    queueMicrotask(() => {
      refresh()
        .catch((e) => setNotice({ kind: "error", text: e instanceof Error ? e.message : "No se pudo cargar." }))
        .finally(() => setLoading(false));
    });
  }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 5000); return () => clearTimeout(timer); }, [notice]);
  if (loading) return <main className="loading"><b>L</b><i /><p>Preparando London Frozen &amp; Hot...</p></main>;
  return <div className="app"><Header view={view} select={setView} />
    {!databaseConfigured && <aside className="demo"><b>Modo demostración</b><span>Al configurar Supabase se usará PostgreSQL.</span><button onClick={() => { resetDemoData(); location.reload(); }}>Restaurar datos demo</button></aside>}
    {notice && <aside className={`notice ${notice.kind}`}><b>{notice.kind === "ok" ? "✓" : "!"}</b><span>{notice.text}</span><button onClick={() => setNotice(null)}>×</button></aside>}
    {view === "sale" && <Sale products={products} invoices={invoices} refresh={refresh} notify={setNotice} />}
    {view === "summary" && <Summary invoices={invoices} select={setSelected} />}
    {view === "people" && <Personas invoices={invoices} />}
    {view === "history" && <History invoices={invoices} select={setSelected} />}
    {view === "reports" && <Reports invoices={invoices} />}
    {view === "products" && <Products products={products} categories={categories} refresh={refresh} notify={setNotice} />}
    {selected && <InvoiceModal invoice={selected} close={() => setSelected(null)} refresh={refresh} notify={setNotice} />}
  </div>;
}
