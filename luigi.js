#!/usr/bin/node

var fs = require("fs");
var child_process = require("child_process");
var rando = (new (require("random-js"))());

var docker_binary = "/usr/local/bin/docker-1.6.2";
var docker_binary = "/usr/bin/docker";



var config = JSON.parse(fs.readFileSync(process.env.HOME + "/.luigi.json"));
var sites = config.sites;

//TODO: throw error if there are two sites with the same lable
//TODO: throw error if any of the sites are missing require elements

function getSite(label) {
    site = sites.filter(function(s) {
	if(label === s.label) {
	    return true;
	}
    })[0];

    if(!site) {
	site = sites[0];
    }
    
    if (!site.email) {
	site.email = config.global.email;
    }

    if (!site.host_server) {
	site.host_server = config.global.host_server;
    }

    return site;
}

function findFreePorts(num, server) {
    console.log("Finding free ports on " + server + ".");

    function isPortFree(port, server) {
	results = child_process.spawnSync("docker-machine ssh " + server + " 'netstat -tulpn | grep \"\:" + port + "\"'");

	if (results.status === 0) { //$? is 0, so the grep found something, meaning that the port is in use
	    return false;
	} else {
	    return true;
	}
    }
    
    ports = [];
    
    while (ports.length < num) {
	possible_port = rando.integer(7000,8000);

	if ( (ports.indexOf(possible_port) == -1) && isPortFree(possible_port, server)) {
	    ports.push(possible_port);
	}
    }

    console.log("Found " + ports);
    
    return ports;
}

function buildDockerImage(site) {
    site.docker_tag = site.label;

    site.content_groups.forEach(function(content_group) {
	site.docker_tag = site.docker_tag + "-" + content_group.external_port;
    })
    
    cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '")' + " && cd " + site.site_dir + " && " + docker_binary + " build -t '" + site.docker_tag + "' ./";
    
    console.log("Building Docker image with the following command: \n\t'" + cmd + "'");
    console.log(child_process.execSync(cmd).toString());

    //TODO throw error if build fails
}

function startDockerImage(site) {
    //-p 127.0.0.1:8091:80

    port_switch = "";
    site.content_groups.forEach(function(content_group) {
	port_switch = port_switch + " -p 127.0.0.1:" + content_group.external_port + ":" + content_group.internal_port + " ";
    })

    cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '")' + " && cd " + docker_binary + " run " + port_switch + " --restart=always -d --name " + site.docker_tag + " " + site.docker_tag;
    
    console.log("Starting Docker container with the following command: \n\t" + cmd);
    console.log(child_process.execSync(cmd).toString());
}

function makeApacheConf(site) {
    function makeVhost(domain, internal_port, external_port, email) {
	return  "\n<VirtualHost *:80>\n" +
	    "ServerAdmin " + email + "\n" +
	    "ServerName " + domain +"\n" +
	    
        "ErrorLog ${APACHE_LOG_DIR}/" + domain + "-error.log\n" +
	    "CustomLog ${APACHE_LOG_DIR}/" + domain + "-access_log common\n" +
	    
        "ProxyPass / http://127.0.0.1:" + external_port + "/\n" +
	    "ProxyPassReverse / http://127.0.0.1:" + external_port + "/\n" +
	    "</VirtualHost>\n";
    }

    vhosts = site.content_groups.map(function (content_group) {
	return content_group.domains.map(function(domain) {
	    return makeVhost(domain, content_group.internal_port, content_group.external_port, content_group.email);
	}).join("");
    })

    conf = vhosts.join("");

    // if(site.paid_domains) {
    // 	//paid domains
    // 	vhosts = site.paid_domains.map(function(d) {
    // 	    return makeVhost(d, site.paidport, site.email);
    // 	});
    // 	conf = conf + vhosts.join("");
    // }

    return conf;
}

function enableSite(site) {
    tmpfilename = "/tmp/" + process.pid + "-" + site.label + ".conf";
    fs.writeFileSync(tmpfilename, conf);
    console.log("Wrote Apache conf to: " + tmpfilename);

    filename = site.host_server + ":/etc/apache2/sites-available/" + site.label + ".conf";
    cmd = "docker-machine scp " + tmpfilename + " " + filename;
    console.log("Transferring " + tmpfilename + " to " + filename + " with this command: \n\t" + cmd);
    console.log(child_process.execSync(cmd).toString());

    cmd = "docker-machine ssh " + site.host_server + " a2ensite " + site.label + ".conf";
    console.log("Enabling site with this command:\n\t" + cmd);
    console.log(child_process.execSync(cmd).toString());

    cmd = "docker-machine ssh " + site.host_server + " service apache2 reload";
    console.log("Reloading Apache on " + site.host_server + "with the following command:\n\t" + cmd);
    console.log(child_process.execSync(cmd).toString());
}

// 1) interpret the first argument as a "label" and find that site object in ~/.luigi.json
site = getSite(process.argv[2]);


// 2) for each site, find the number of content groups. find a number of free nonprivileged ports on the target server equal to this number and store them, assigning one to each content group

external_ports = findFreePorts(site.content_groups.length, site.host_server);

site.content_groups = site.content_groups.map(function(content_group) {
    content_group.external_port = external_ports.pop();
    return content_group;
})

// 3) build the site_dir, tagging the image in the form "$label-$freeport-$paidport"

buildDockerImage(site);
    
// 4) start the docker image, mapping internal port 80 to $freeport, and internal port 81 to $paidport

startDockerImage(site);

// 5) generate an httpd.conf file for the site

site.conf = makeApacheConf(site);

// 6) After generating the conf, move it to /etc/apache2/sites-available/$label.conf on the hosting server, enable it (a2enable), and reload the apache config ("service apache2 reload")

enableSite(site);

// 7) Finally, find other running docker containers whose label is of the form /$label\-[0-9]+\-[0-9]+/ (aka "hot-stock-tips-4038-3994") and stop them.

cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '") && ' + docker_binary + " ps | awk '{print $NF}' | sed '1d'";
to_kill = child_process.execSync(cmd).toString()
    .split("\n")
    .filter(function(x) {
	if(x.includes(site.label) && x != site.docker_tag) {
	    return true;
	} else {
	    return false;
	}
    });

to_kill.forEach(function(x) {
    cmd = 'eval $(docker-machine env --shell bash "' + site.host_server + '") && ' + docker_binary + " stop " + x;
    console.log("Stopping container " + x + " on " + site.host_server + " with this command:\n\t" + cmd );
    console.log(child_process.execSync(cmd).toString());
});

// 8) Clean up unused docker images.

// cmd =  "clear_docker_images.sh";
// console.log("Removing unnecessary docker images and containers with the following command:\n\t" + cmd);
// console.log(child_process.execSync(cmd).toString());
