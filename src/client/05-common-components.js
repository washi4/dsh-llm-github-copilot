    function formatCreditsNumber(value) {
      try {
        const locale = localeRuntime?.getSnapshot().active === "zh" ? "zh-CN" : "en-US";
        return new Intl.NumberFormat(locale).format(value);
      } catch {
        return String(value);
      }
    }

    function formatCreditsResetDate(value) {
      const timestamp = Date.parse(value);
      if (!Number.isFinite(timestamp)) return void 0;
      try {
        const locale = localeRuntime?.getSnapshot().active === "zh" ? "zh-CN" : "en-US";
        return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(timestamp);
      } catch {
        return void 0;
      }
    }

    function CreditsCard({ credits }) {
      useLocaleRevision();
      const state = credits?.state;
      const resetDate = formatCreditsResetDate(credits?.quotaResetDate);
      const details = [
        typeof credits?.remaining === "number"
          ? jsx("p", { style: css.creditsMetric, children: text("creditsRemaining", { count: formatCreditsNumber(credits.remaining) }) }, "remaining")
          : null,
        typeof credits?.entitlement === "number"
          ? jsx("p", { style: css.creditsMetric, children: text("creditsEntitlement", { count: formatCreditsNumber(credits.entitlement) }) }, "entitlement")
          : null,
        resetDate === void 0 ? null : jsx("p", { style: css.creditsMetric, children: text("creditsReset", { date: resetDate }) }, "reset"),
        typeof credits?.plan === "string" && credits.plan.length > 0
          ? jsx("p", { style: css.creditsMetric, children: text("creditsPlan", { plan: credits.plan }) }, "plan")
          : null
      ];
      if (state === "available") {
        const usedPercent = typeof credits.usedPercent === "number" && Number.isFinite(credits.usedPercent)
          ? Math.min(100, Math.max(0, credits.usedPercent))
          : void 0;
        if (usedPercent === void 0) return jsx("div", {
          style: css.creditsCard,
          children: [
            jsx("h3", { style: css.creditsTitle, children: text("creditsTitle") }),
            jsx("p", { style: css.creditsMetric, children: text("creditsUnavailable") })
          ]
        });
        return jsxs("div", {
          style: css.creditsCard,
          children: [
            jsx("h3", { style: css.creditsTitle, children: text("creditsTitle") }),
            jsx("p", { style: css.creditsValue, children: text("creditsUsed", { percent: Math.round(usedPercent) }) }),
            jsx("div", {
              role: "progressbar",
              "aria-label": text("creditsTitle"),
              "aria-valuemin": 0,
              "aria-valuemax": 100,
              "aria-valuenow": usedPercent,
              style: css.creditsProgress,
              children: jsx("div", { style: { ...css.creditsProgressBar, width: `${usedPercent}%` } })
            }),
            jsx("div", { style: css.creditsGrid, children: details })
          ]
        });
      }
      const unavailableDetails = details.filter(Boolean);
      if (state === "unlimited") {
        return jsxs("div", {
          style: css.creditsCard,
          children: [
            jsx("h3", { style: css.creditsTitle, children: text("creditsTitle") }),
            jsx("p", { style: css.creditsValue, children: text("creditsUnlimited") }),
            jsx("div", { style: css.creditsGrid, children: details })
          ]
        });
      }
      return jsxs("div", {
        style: css.creditsCard,
        children: [
          jsx("h3", { style: css.creditsTitle, children: text("creditsTitle") }),
          jsx("p", { style: css.creditsMetric, children: text("creditsUnavailable") }),
          unavailableDetails.length === 0 ? null : jsx("div", { style: css.creditsGrid, children: unavailableDetails })
        ]
      });
    }

    function StateLabel({ status }) {
      useLocaleRevision();
      const authenticated = status?.authenticated === true;
      const pending = status?.state === "pending";
      const label = authenticated ? text("signedIn") : pending ? text("pending") : text("signedOut");
      const state = authenticated ? "done" : pending ? "ongoing" : "error";
      return jsxs("span", { style: css.status, children: [jsx(StateDot, { state }), label] });
    }

    function DeviceCodeField({ value, copied, onCopy }) {
      useLocaleRevision();
      return jsxs("div", {
        style: css.field,
        children: [
          jsx("span", { style: css.label, children: text("deviceCode") }),
          jsxs("div", {
            style: css.codeRow,
            children: [
              jsx(Input, {
                readOnly: true,
                value,
                "aria-label": text("deviceCode"),
                onFocus: (event) => { event.currentTarget.select(); },
                style: { width: "180px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", letterSpacing: "2px", fontWeight: 600 }
              }),
              jsx(Button, { variant: "outline", size: "sm", onClick: onCopy, children: copied ? text("copied") : text("copyCode") })
            ]
          })
        ]
      });
    }
