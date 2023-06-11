FROM ubuntu:latest

WORKDIR /root

RUN apt-get update
RUN apt-get -y install curl git jq

# Download the nodesource PPA for Node.js
RUN curl https://deb.nodesource.com/setup_16.x | bash


# Download the Yarn repository configuration
# See instructions on https://legacy.yarnpkg.com/en/docs/install/
RUN curl -sS https://dl.yarnpkg.com/debian/pubkey.gpg | apt-key add -
RUN echo "deb https://dl.yarnpkg.com/debian/ stable main" | tee /etc/apt/sources.list.d/yarn.list

# Update Ubuntu
RUN apt update
RUN apt upgrade -y

# Install Node.js, Yarn, and build tools
# Install jq for formatting of JSON data
RUN apt install nodejs=16.* yarn build-essential jq make -y


# First remove any existing old Go installation
RUN rm -rf /usr/local/go

# Install correct Go version
RUN curl https://dl.google.com/go/go1.20.4.linux-amd64.tar.gz | tar -C/usr/local -zxvf -

# Update environment variables to include go
ENV GOROOT=/usr/local/go
ENV GOPATH=$HOME/go
ENV GO111MODULE=on
ENV PATH=$PATH:/usr/local/go/bin:$HOME/go/bin
RUN /bin/bash -c "source $HOME/.profile"

RUN git clone https://github.com/schnetzlerjoe/agoric-sdk

RUN cd agoric-sdk && git checkout pegasus-memo && yarn install --network-timeout 1000000 && yarn build && yarn link-cli ~/bin/agoric

EXPOSE 8000

WORKDIR /agoric-sdk/packages/cosmic-swingset

RUN make scenario2-setup
RUN nohup make scenario2-run-chain-economy

CMD [ "make", "scenario2-run-client" ]