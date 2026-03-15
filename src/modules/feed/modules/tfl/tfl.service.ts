import {
  Inject,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common"
import { REQUEST } from "@nestjs/core"
import { BBox } from "geojson"
import ms from "ms"
import type {
  FeedContext,
  FeedProvider,
  RouteAtStop,
  Stop,
  StopRoute,
  TripStop,
} from "src/modules/feed/interfaces/feed-provider.interface"
import { RegisterFeedProvider } from "../../decorators/feed-provider.decorator"
import { FeedCacheService } from "../feed-cache/feed-cache.service"
import { TflConfig, TflConfigSchema } from "./config"

interface TflPrediction {
  id: string
  operationType: number
  vehicleId: string
  naptanId: string
  stationName: string
  lineId: string
  lineName: string
  platformName: string
  direction: string
  bearing: string
  destinationNaptanId: string
  destinationName: string
  timestamp: string
  timeToStation: number
  currentLocation: string
  towards: string
  expectedArrival: string
  timeToLive: string
  modeName: string
}

interface TflStopPoint {
  naptanId: string
  indicator: string | null
  stopLetter: string | null
  commonName: string
  lat: number
  lon: number
  stopType: string
  lines: { id: string; name: string }[]
}

interface TflStopPointSearchResponse {
  stopPoints: TflStopPoint[]
}

interface TflLineRoute {
  lineId: string
  lineName: string
  direction: string
  destinationName: string
}

@RegisterFeedProvider("tfl")
export class TflService implements FeedProvider {
  private logger: Logger
  private config: Readonly<TflConfig>
  private baseUrl: string

  constructor(
    @Inject(REQUEST) { feedCode, config }: FeedContext<TflConfig>,
    private readonly cache: FeedCacheService,
  ) {
    this.logger = new Logger(`${TflService.name}[${feedCode}]`)
    this.config = TflConfigSchema.parse(config)
    this.baseUrl = this.config.baseUrl
  }

  async healthCheck(): Promise<void> {
    await this.fetchJson<TflPrediction[]>(
      `/StopPoint/940GZZLUWSM/arrivals`,
    )
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`)
    if (this.config.apiKey?.length) {
      url.searchParams.set("app_key", this.config.apiKey)
    }

    const response = await fetch(url.toString())
    if (!response.ok) {
      if (response.status === 404) {
        throw new NotFoundException(`Resource not found: ${path}`)
      }
      throw new InternalServerErrorException(
        `TFL API request failed: ${response.status} ${response.statusText}`,
      )
    }
    return response.json()
  }

  async getStop(stopId: string): Promise<Stop> {
    return this.cache.cached(
      `stop-${stopId}`,
      async () => {
        this.logger.log(
          `Fetching stop location for ${stopId} (one-time lookup)`,
        )
        const stopPoint = await this.fetchJson<TflStopPoint>(
          `/StopPoint/${encodeURIComponent(stopId)}`,
        )

        return {
          stopId: stopPoint.naptanId,
          stopCode: stopPoint.stopLetter ?? stopPoint.indicator ?? null,
          name: stopPoint.commonName,
          lat: stopPoint.lat,
          lon: stopPoint.lon,
        }
      },
      ms("365d"),
    )
  }

  private getDirectionLabel(platformName: string): string {
    const label = platformName.split(" - ")[0]?.trim()
    return label || platformName
  }

  private getDirectionalRouteId(
    lineId: string,
    direction: string,
  ): string {
    return `${lineId}-${direction}`
  }

  async getRoutesForStop(stopId: string): Promise<StopRoute[]> {
    return this.cache.cached(
      `routesForStop-${stopId}`,
      async () => {
        const arrivals = await this.fetchJson<TflPrediction[]>(
          `/StopPoint/${encodeURIComponent(stopId)}/arrivals`,
        )

        const routeMap = new Map<
          string,
          {
            routeId: string
            name: string
            color: string | null
            headsigns: Set<string>
          }
        >()

        for (const arrival of arrivals) {
          const routeId = this.getDirectionalRouteId(
            arrival.lineId,
            arrival.direction,
          )
          const directionLabel = this.getDirectionLabel(arrival.platformName)
          const headsign = arrival.towards || arrival.destinationName
          if (!routeMap.has(routeId)) {
            routeMap.set(routeId, {
              routeId,
              name: `${arrival.lineName} (${directionLabel})`,
              color: null,
              headsigns: new Set([headsign]),
            })
          } else {
            routeMap.get(routeId)!.headsigns.add(headsign)
          }
        }

        return Array.from(routeMap.values()).map((route) => ({
          routeId: route.routeId,
          name: route.name,
          color: route.color,
          headsigns: Array.from(route.headsigns),
        }))
      },
      ms("1h"),
    )
  }

  async getStopsInArea(bbox: BBox): Promise<Stop[]> {
    const [swLon, swLat, neLon, neLat] = bbox

    const centerLat = (swLat + neLat) / 2
    const centerLon = (swLon + neLon) / 2

    // Calculate radius in meters from center to corner of bbox
    const latDiff = Math.abs(neLat - swLat) / 2
    const lonDiff = Math.abs(neLon - swLon) / 2
    const latMeters = latDiff * 111_320
    const lonMeters = lonDiff * 111_320 * Math.cos((centerLat * Math.PI) / 180)
    const radius = Math.min(
      Math.ceil(Math.sqrt(latMeters ** 2 + lonMeters ** 2)),
      2000,
    )

    const stopTypes = [
      "NaptanMetroStation",
      "NaptanRailStation",
      "NaptanBusCoachStation",
      "NaptanPublicBusCoachTram",
    ].join(",")

    let stopPoints: TflStopPoint[]
    try {
      const response = await this.fetchJson<TflStopPointSearchResponse>(
        `/StopPoint?lat=${centerLat}&lon=${centerLon}&radius=${radius}&stopTypes=${stopTypes}`,
      )
      stopPoints = response.stopPoints ?? []
    } catch (e: any) {
      if (e.status === 404 || e.getStatus?.() === 404) {
        return []
      }
      throw e
    }

    return stopPoints
      .filter(
        (sp) =>
          sp.lon >= swLon &&
          sp.lon <= neLon &&
          sp.lat >= swLat &&
          sp.lat <= neLat,
      )
      .map<Stop>((sp) => ({
        stopId: sp.naptanId,
        stopCode: sp.stopLetter ?? sp.indicator ?? null,
        name: sp.commonName,
        lat: sp.lat,
        lon: sp.lon,
      }))
  }

  async getUpcomingTripsForRoutesAtStops(
    routes: RouteAtStop[],
  ): Promise<TripStop[]> {
    const stopRouteMap = routes.reduce(
      (acc, { routeId, stopId }) => {
        if (!acc[stopId]) {
          acc[stopId] = []
        }
        acc[stopId].push(routeId)
        return acc
      },
      {} as Record<string, string[]>,
    )

    const tripStops: TripStop[] = []

    for (const stopId of Object.keys(stopRouteMap)) {
      const routeIds = stopRouteMap[stopId]

      const arrivals = await this.cache.cached(
        `arrivals-${stopId}`,
        async () => {
          const predictions = await this.fetchJson<TflPrediction[]>(
            `/StopPoint/${encodeURIComponent(stopId)}/arrivals`,
          )

          const now = new Date()
          const validPredictions = predictions.filter(
            (p) => new Date(p.expectedArrival) > now,
          )

          let ttl = ms("30s")
          if (validPredictions.length === 0) {
            ttl = ms("2m")
          }

          return { value: predictions, ttl }
        },
      )

      if (!arrivals) {
        continue
      }

      const filteredArrivals = arrivals.filter((a) =>
        routeIds.includes(
          this.getDirectionalRouteId(a.lineId, a.direction),
        ),
      )

      for (const arrival of filteredArrivals) {
        const arrivalTime = new Date(arrival.expectedArrival)

        if (arrivalTime.getTime() < Date.now()) {
          continue
        }

        const routeId = this.getDirectionalRouteId(
          arrival.lineId,
          arrival.direction,
        )
        const directionLabel = this.getDirectionLabel(arrival.platformName)
        const tripId = `${arrival.vehicleId}-${routeId}-${arrival.expectedArrival}`

        if (
          tripStops.some((ts) => ts.tripId === tripId && ts.stopId === stopId)
        ) {
          continue
        }

        const stop = await this.getStop(stopId)

        tripStops.push({
          tripId,
          stopId,
          routeId,
          routeName: `${arrival.lineName} (${directionLabel})`,
          routeColor: null,
          stopName: stop.name,
          directionId: arrival.direction ?? null,
          headsign: arrival.towards || arrival.destinationName,
          arrivalTime,
          departureTime: arrivalTime,
          isRealtime: true,
        })
      }
    }

    return tripStops
  }
}
