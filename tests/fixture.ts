import type { Dataset, DatedFilm, RatedFilm } from "../src/types.ts";

const F = {
  amelie: { name: "Amélie", year: 2001, uri: "https://boxd.it/a1" },
  se7en: { name: "Se7en", year: 1995, uri: "https://boxd.it/s7" },
  wailing: { name: "The Wailing", year: 2016, uri: "https://boxd.it/w1" },
  susp77: { name: "Suspiria", year: 1977, uri: "https://boxd.it/s77" },
  susp18: { name: "Suspiria", year: 2018, uri: "https://boxd.it/s18" },
  heat: { name: "Heat", year: 1995, uri: "https://boxd.it/h1" },
  padd: { name: "Paddington 2", year: 2017, uri: "https://boxd.it/p2" },
  cats: { name: "Cats", year: 2019, uri: "https://boxd.it/c1" },
};

const d = (f: (typeof F)[keyof typeof F], date = "2025-08-17"): DatedFilm => ({ ...f, date });
const r = (f: (typeof F)[keyof typeof F], rating: number, date = "2025-08-17"): RatedFilm => ({
  ...f,
  date,
  rating,
});

/**
 * 6 rated (avg 3.6), 7 watched (Heat watched but unrated), 1 watchlist (The Wailing),
 * 3 diary, 1 review, 1 liked.
 */
export function fixture(): Dataset {
  return {
    username: "DatMomoAgain",
    uploadedAt: "2026-11-14T00:00:00.000Z",
    ratings: [
      r(F.amelie, 4.5),
      r(F.se7en, 4),
      r(F.susp77, 4),
      r(F.susp18, 3),
      r(F.padd, 5),
      r(F.cats, 1),
    ],
    watched: [d(F.amelie), d(F.se7en), d(F.susp77), d(F.susp18), d(F.heat), d(F.padd), d(F.cats)],
    watchlist: [d(F.wailing, "2025-08-18")],
    diary: [
      { ...d(F.se7en, "2025-09-11"), watchedDate: "2025-09-10", rating: 4, rewatch: false, tags: [] },
      { ...d(F.padd, "2025-10-06"), watchedDate: "2025-10-05", rating: 5, rewatch: true, tags: ["comfort"] },
      { ...d(F.cats, "2025-11-01"), watchedDate: null, rating: 1, rewatch: false, tags: [] },
    ],
    reviews: [
      {
        ...d(F.padd, "2025-10-06"),
        watchedDate: "2025-10-05",
        rating: 5,
        rewatch: true,
        tags: [],
        review: "Perfect.",
      },
    ],
    likedFilms: [d(F.heat)],
  };
}
