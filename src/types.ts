export interface Film {
  name: string;
  year: number | null;
  /** Letterboxd short URI, e.g. https://boxd.it/29EW — stable id across lists. */
  uri: string;
}

/** `date` is YYYY-MM-DD: when the entry was added/logged on Letterboxd. */
export interface DatedFilm extends Film {
  date: string;
}

/** `rating` is 0.5–5 in half-star steps. */
export interface RatedFilm extends DatedFilm {
  rating: number;
}

export interface DiaryEntry extends DatedFilm {
  watchedDate: string | null;
  rating: number | null;
  rewatch: boolean;
  tags: string[];
}

export interface Review extends DiaryEntry {
  review: string;
}

export interface Dataset {
  username: string;
  uploadedAt: string;
  ratings: RatedFilm[];
  watched: DatedFilm[];
  watchlist: DatedFilm[];
  diary: DiaryEntry[];
  reviews: Review[];
  likedFilms: DatedFilm[];
}

/** Relative path inside the export ("likes/films.csv") → file text. */
export type ExportFiles = Record<string, string>;
