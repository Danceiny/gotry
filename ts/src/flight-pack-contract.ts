/** Internal flight-pack provenance; symbol properties stay out of JSON/public tool schemas. */
export const FLIGHT_PACK_VERSION: unique symbol = Symbol('gotry.flightPackVersion')

export type FlightPackVersion = 1 | 2
