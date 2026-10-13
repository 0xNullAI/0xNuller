import { useRef, useState } from 'react';
import { redeemCreditCode } from '@0xnullai/auth';
import { normalizeRedeemCode } from '@0xnullai/auth/credit-tiers';
import { Button } from '@0xnullai/ui';
import { refreshCreditBalance } from '../credit-balance';

/** Credit is bought as a redeem key from the operator; this is where a user turns it into Credit. */
export function RedeemCodePanel() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lock = useRef(false);
  const valid = normalizeRedeemCode(code) !== null;

  async function submit() {
    if (lock.current || !valid) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await redeemCreditCode(code);
      setCode('');
      setNotice(`兑换成功，已到账 ${result.amountCredits} Credit`);
      refreshCreditBalance();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '兑换失败，请稍后再试');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return (
    <form
      aria-label="卡密兑换"
      className="space-y-2 border-b border-[var(--surface-border)] pb-3 text-xs"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="block text-sm font-medium" htmlFor="redeem-code">
        卡密兑换
      </label>
      <textarea
        id="redeem-code"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        rows={2}
        spellCheck={false}
        autoCapitalize="characters"
        autoComplete="off"
        placeholder="粘贴 64 位卡密"
        className="w-full resize-none rounded border border-[var(--surface-border)] bg-[var(--bg)] p-2 font-mono text-xs break-all"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" type="submit" disabled={busy || !valid}>
          {busy ? '兑换中…' : '兑换'}
        </Button>
        {code && !valid ? <span className="text-[var(--text-faint)]">卡密应为 64 位</span> : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </form>
  );
}
