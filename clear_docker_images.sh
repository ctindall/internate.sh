#!/bin/bash

eval $(docker-machine env --shell bash "$1")

/usr/bin/docker rmi $(/usr/bin/docker images -qa) 2&> /dev/null
/usr/bin/docker rm $(/usr/bin/docker ps -qa) 2&> /dev/null

exit 0
