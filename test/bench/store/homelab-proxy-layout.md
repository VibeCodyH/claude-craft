---
name: homelab-proxy-layout
description: Homelab HTTP services enter through one reverse proxy on the edge network
metadata:
  type: reference
---

The fictional homelab has one reverse proxy attached to the edge and services networks. Applications live only on the services network and expose no host ports. TLS terminates at the proxy; internal upstream traffic is plain HTTP.

Admin dashboards require the private tunnel described in [[vpn-admin-access]].
