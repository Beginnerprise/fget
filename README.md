# Overview
F(ast)GET is a quick tool to use chunking when possible on an http request to attempt to get maximum speed for your downloads.  FGet is intended to be a drop in replacement for the basic functionality of wget.

## How does it work?
The command runs a HTTP head request against the url provided and checks if the server supports byte ranges.  If the server supports chunking, FGET will break up the file into multiple sections and run multiple HTTP requests in parallel against the server.  Otherwise, the request falls back to a single stream like WGET or Curl.

## Example Usage
Command line:

```
-> npm install -g fget
-> fget <url_to_file>
```

NPM:

```
var fget = require('fget');

var reqOptions = {
  uri: options['<url>']
};

fget.get(reqOptions, function(err, res) {
  if (err || res !== true) {
    throw new Error("Poop!");
  }
  console.log("The file is in the current directory");
});
```

## Comparison
Depending on the latency, tcp windows size, and various other factors fget can get anywhere from 200% to 1000% improvements.

```
-> wget http://mirror.internode.on.net/pub/test/1000meg.test
79,412,138     4.37M/s    ETA 03:58
-> fget http://mirror.internode.on.net/pub/test/1000meg.test     
82%    22MB/s   7.7s
```
