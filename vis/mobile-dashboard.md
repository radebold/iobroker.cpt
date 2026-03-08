# cpt mobile VIS example

## Top row
- Button label: 🔄 Refresh
- Data point: `cpt.0.tools.refreshNow`
- Click value: `true`
- Suggested position: top right

## Useful states
- nearest station name: `cpt.0.nearestType2.name`
- nearest distance: `cpt.0.nearestType2.distanceM`
- nearest free ports: `cpt.0.nearestType2.freePorts`
- SOC: `cpt.0.car.soc`
- last refresh: `cpt.0.tools.lastRefresh`
- refresh result: `cpt.0.tools.lastRefreshResult`

## Suggested mobile layout
1. Top bar with title on the left and refresh button on the right
2. Large card for nearest free Type2 station
3. Small row with SOC, distance and free ports
4. Status line with last refresh and refresh result
