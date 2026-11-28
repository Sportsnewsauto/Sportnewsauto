export type LocalDayBounds = {
  start: Date;
  end: Date;
  timezone: string;
};

function resolveTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return timezone;
  } catch {
    return "Africa/Nairobi";
  }
}

/**
 * Returns UTC timestamps bounding the current calendar day in the supplied
 * IANA timezone. The conversion uses Intl so daylight-saving transitions are
 * handled using the timezone's actual offset for each midnight.
 */
export function getLocalDayBounds(
  timezone: string,
  now: Date = new Date(),
): LocalDayBounds {
  const safeTimezone = resolveTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  function partsAt(value: Date): Record<string, number> {
    return Object.fromEntries(
      formatter.formatToParts(value).map((part) => [part.type, Number(part.value)]),
    );
  }

  const localNow = partsAt(now);
  const midnightAsUtc = Date.UTC(localNow.year, localNow.month - 1, localNow.day);

  function localMidnightToUtc(localMidnight: number): Date {
    let guess = localMidnight;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observed = partsAt(new Date(guess));
      const observedAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      );
      const adjustment = localMidnight - observedAsUtc;
      guess += adjustment;
      if (adjustment === 0) break;
    }
    return new Date(guess);
  }

  return {
    start: localMidnightToUtc(midnightAsUtc),
    end: localMidnightToUtc(midnightAsUtc + 24 * 60 * 60 * 1000),
    timezone: safeTimezone,
  };
}
