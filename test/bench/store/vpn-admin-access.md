---
name: vpn-admin-access
description: Infrastructure admin pages are reachable only through the private VPN
metadata:
  type: project
---

Monitoring, storage, and hypervisor dashboards bind to the management network and are routed only through the private VPN. The public reverse proxy must not forward their hostnames.

The network boundary complements [[homelab-proxy-layout]].
