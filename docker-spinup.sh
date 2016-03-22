#!/bin/bash

docker-spinup () {
 docker-machine create \
    --driver digitalocean \
    --digitalocean-access-token="4fc7ea67bc54eaa5944741bd971cf4fa71425b632b6a08e080a4d2f64705b099" \
    --digitalocean-size 1gb \
    $1
}

docker-spinup "$1"
eval $(docker-machine env --shell bash "$1")

docker-machine ssh "$1" "export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get -y upgrade && apt-get -y install apache2 && a2enmod proxy && a2enmod proxy_http && service apache2 restart"

cat ~/.luigi.json | jq .sites[].label | grep -o "[a-z-]*" | while read l; do luigi.js $l; done
