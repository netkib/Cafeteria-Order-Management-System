
export type PrintTokenData = {
  orderId: string;
  idempotencyKey?: string;
  itemName: string;
  details?: string[];
  quantity: number;
  priceBdt: number;
  totalBdt: number;
  printedAt?: string; 
};

type Props = {
  data: PrintTokenData;
  compact?: boolean;
  footerNote?: string;
};

export function PrintToken({ data, compact = true, footerNote }: Props) {
  const {
    orderId,
    idempotencyKey,
    itemName,
    details = [],
    quantity,
    priceBdt,
    totalBdt,
    printedAt,
  } = data;

  return (
    <div
      className={[
        "bg-white text-black",
        "border-2 border-black",
        "p-3",
        compact ? "w-[80mm] max-w-[80mm]" : "w-full",
        "font-mono",
      ].join(" ")}
    >
      <div className="text-[13px] font-extrabold tracking-tight">CAFETERIA TOKEN</div>

      <div className="mt-1 text-[11px]">
        Time: <span className="font-semibold">{printedAt ?? new Date().toLocaleString()}</span>
      </div>

      <div className="mt-2 text-[11px] leading-snug">
        <span className="font-extrabold">Order ID:</span>{" "}
        <span className="break-all">{orderId}</span>
      </div>

      <div className="mt-1 text-[11px] leading-snug">
        <span className="font-extrabold">Idempotency:</span>{" "}
        <span className="break-all">{idempotencyKey || "N/A"}</span>
      </div>

      <div className="my-3 border-t-2 border-dashed border-black" />

      <div className="text-[12px] font-extrabold">{itemName}</div>

      {details.length > 0 ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] leading-snug">
          {details.slice(0, 10).map((d, idx) => (
            <li key={idx}>{d}</li>
          ))}
        </ul>
      ) : (
        <div className="mt-2 text-[11px]">(No details)</div>
      )}

      <div className="my-3 border-t-2 border-dashed border-black" />

      <div className="text-[11px] leading-snug">
        <span className="font-extrabold">Quantity:</span> {quantity}
      </div>
      <div className="mt-1 text-[11px] leading-snug">
        <span className="font-extrabold">Price:</span> BDT {priceBdt}
      </div>
      <div className="mt-1 text-[11px] leading-snug">
        <span className="font-extrabold">Total:</span> BDT {totalBdt}
      </div>

      {footerNote ? (
        <>
          <div className="my-3 border-t-2 border-dashed border-black" />
          <div className="text-center text-[11px] font-semibold">{footerNote}</div>
        </>
      ) : null}
    </div>
  );
}

export default PrintToken;