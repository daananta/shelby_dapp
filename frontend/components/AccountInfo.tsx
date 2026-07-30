import { useWallet } from "@aptos-labs/wallet-adapter-react";
// Internal components
import { LabelValueGrid, DisplayValue } from "@/components/LabelValueGrid";

export function AccountInfo() {
  const { account } = useWallet();
  return (
    <div className="flex flex-col gap-6">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-600">Tài khoản</h4>
      <LabelValueGrid
        items={[
          {
            label: "Địa chỉ",
            value: <DisplayValue value={account?.address .toStringLong()?? "Not Present"} isCorrect={!!account?.address} />,
          },
          {
            label: "Khoá công khai",
            value: (
              <DisplayValue value={account?.publicKey.toString() ?? "Not Present"} isCorrect={!!account?.publicKey} />
            ),
          },
          {
            label: "Tên ANS",
            subLabel: "(nếu có)",
            value: <p>{account?.ansName ?? "Chưa có"}</p>,
          },
        ]}
      />
    </div>
  );
}
